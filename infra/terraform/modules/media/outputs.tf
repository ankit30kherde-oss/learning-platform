output "bucket_name" { value = aws_s3_bucket.media.bucket }
output "cloudfront_domain" { value = aws_cloudfront_distribution.media.domain_name }
output "cloudfront_key_pair_id" { value = aws_cloudfront_public_key.media.id }
output "cloudfront_private_key_pem" {
  value     = tls_private_key.signing.private_key_pem
  sensitive = true
}
output "media_service_role_arn" { value = aws_iam_role.media_service.arn }
