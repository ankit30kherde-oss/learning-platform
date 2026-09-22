variable "environment" { type = string }
variable "database_endpoint" { type = string }
variable "database_service_passwords" {
  type      = map(string)
  sensitive = true
}
variable "redis_endpoint" { type = string }
variable "redis_auth_token" {
  type      = string
  sensitive = true
}
variable "razorpay_key_id" { type = string }
variable "razorpay_key_secret" {
  type      = string
  sensitive = true
}
variable "razorpay_webhook_secret" {
  type      = string
  sensitive = true
}
variable "cloudfront_domain" { type = string }
variable "cloudfront_key_pair_id" { type = string }
variable "cloudfront_private_key_pem" {
  type      = string
  sensitive = true
}
variable "media_bucket_name" { type = string }
variable "smtp_host" {
  type    = string
  default = "email-smtp.ap-south-1.amazonaws.com"
}
variable "smtp_port" {
  type    = number
  default = 587
}
variable "smtp_user" {
  type    = string
  default = ""
}
variable "smtp_password" {
  type      = string
  sensitive = true
  default   = ""
}
variable "mail_from" {
  type    = string
  default = "DevOps Academy <no-reply@devopsacademy.example.com>"
}
variable "tags" {
  type    = map(string)
  default = {}
}
