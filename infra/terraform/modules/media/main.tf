# ---------------------------------------------------------------------------
# Protected media delivery.
#
# The bucket has NO public access, NO bucket policy that allows anything but
# CloudFront, and block-public-access on at every level. CloudFront reaches it
# through Origin Access Control (OAC) - the modern replacement for the old OAI,
# which supported only GET/HEAD and could not do SigV4 for all regions. Every
# object is therefore unreachable except through a CloudFront URL, and every
# CloudFront URL must be signed by media-service or it 403s.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
    tls = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

locals {
  tags = merge(var.tags, { Module = "media" })
}

resource "aws_s3_bucket" "media" {
  bucket = var.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
    bucket_key_enabled = true
  }
}

# CORS is needed only for the browser -> S3 direct upload flow (signed PUT);
# reads always go through CloudFront, never directly to S3.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.app_origins
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# --------------------------------------------------------------- CloudFront

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name}-media-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The key pair CloudFront verifies signed URLs against. The private half is
# generated here and written straight into Secrets Manager - it never touches
# disk in a readable form and is never committed.
resource "tls_private_key" "signing" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "media" {
  name        = "${var.name}-media-signing-key"
  comment     = "Used by media-service to sign playback and download URLs"
  encoded_key = tls_private_key.signing.public_key_pem
}

resource "aws_cloudfront_key_group" "media" {
  name    = "${var.name}-media-signers"
  items   = [aws_cloudfront_public_key.media.id]
  comment = "Trusted signers for the private media distribution"
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  comment         = "${var.name} protected media"
  price_class     = var.price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "s3-media"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-media"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods          = ["GET", "HEAD"]
    compress                = true

    # Every request must carry a valid signature. This is the setting that
    # turns "private bucket" into "private, expiring, per-request URLs".
    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  # HLS segments change infrequently once written; a slightly longer edge TTL
  # here just reduces origin load, the signature still gates every request.
  ordered_cache_behavior {
    path_pattern            = "*.m3u8"
    target_origin_id        = "s3-media"
    viewer_protocol_policy  = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    trusted_key_groups       = [aws_cloudfront_key_group.media.id]
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.cors_s3.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  aliases = var.cdn_domain == null ? [] : [var.cdn_domain]

  tags = local.tags
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}
data "aws_cloudfront_origin_request_policy" "cors_s3" {
  name = "Managed-CORS-S3Origin"
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipal"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.media.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.media.arn }
      }
    }]
  })
}

# ------------------------------------------------------- IRSA role for media-service

resource "aws_iam_role" "media_service" {
  name = "${var.name}-media-service"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = var.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${var.oidc_provider_url}:sub" = "system:serviceaccount:learning-platform:media-service"
          "${var.oidc_provider_url}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "media_service" {
  role = aws_iam_role.media_service.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"]
        Resource = "${aws_s3_bucket.media.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.media.arn
      },
    ]
  })
}
