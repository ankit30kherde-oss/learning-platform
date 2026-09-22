# ---------------------------------------------------------------------------
# The one Secrets Manager entry External Secrets Operator syncs into the
# cluster as `platform-secrets` (see infra/kubernetes/base/external-secrets.yaml).
#
# Everything the running services need that must not be in git lives here:
# database URLs (assembled from the database module's outputs), JWT signing
# keys, the Razorpay webhook secret, the CloudFront signing key. Terraform
# writes it once; rotating a value afterwards is a Secrets Manager operation,
# not a redeploy.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.82" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  tags = merge(var.tags, { Module = "secrets" })
}

resource "random_password" "jwt_access" {
  length = 64
}
resource "random_password" "jwt_refresh" {
  length = 64
}
resource "random_password" "internal_api_key" {
  length  = 48
  special = false
}
resource "random_password" "certificate_signing" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "platform" {
  name                    = "lp/${var.environment}/platform"
  recovery_window_in_days = var.environment == "production" ? 30 : 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "platform" {
  secret_id = aws_secretsmanager_secret.platform.id
  secret_string = jsonencode(merge(
    {
      for db, pass in var.database_service_passwords :
      "${upper(replace(db, "_db", ""))}_DATABASE_URL" =>
      "postgresql://${replace(db, "_db", "")}_app:${pass}@${var.database_endpoint}:5432/${db}?schema=public&sslmode=require"
    },
    {
      REDIS_URL                     = "rediss://:${var.redis_auth_token}@${var.redis_endpoint}:6379"
      JWT_ACCESS_SECRET             = random_password.jwt_access.result
      JWT_REFRESH_SECRET            = random_password.jwt_refresh.result
      INTERNAL_API_KEY              = random_password.internal_api_key.result
      CERTIFICATE_SIGNING_SECRET    = random_password.certificate_signing.result
      RAZORPAY_KEY_ID               = var.razorpay_key_id
      RAZORPAY_KEY_SECRET           = var.razorpay_key_secret
      RAZORPAY_WEBHOOK_SECRET       = var.razorpay_webhook_secret
      NEXT_PUBLIC_RAZORPAY_KEY_ID   = var.razorpay_key_id
      CLOUDFRONT_DOMAIN             = var.cloudfront_domain
      CLOUDFRONT_KEY_PAIR_ID        = var.cloudfront_key_pair_id
      CLOUDFRONT_PRIVATE_KEY_B64    = base64encode(var.cloudfront_private_key_pem)
      MEDIA_BUCKET                  = var.media_bucket_name
      SMTP_HOST                     = var.smtp_host
      SMTP_PORT                     = tostring(var.smtp_port)
      SMTP_USER                     = var.smtp_user
      SMTP_PASS                     = var.smtp_password
      MAIL_FROM                     = var.mail_from
    }
  ))
}
