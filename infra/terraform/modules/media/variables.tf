variable "name" { type = string }
variable "bucket_name" { type = string }
variable "app_origins" {
  description = "Origins allowed to PUT directly to the bucket (the admin upload UI)"
  type        = list(string)
}
variable "price_class" {
  type    = string
  default = "PriceClass_200" # skip South America / Australia edge locations
}
variable "acm_certificate_arn" {
  type    = string
  default = null
}
variable "cdn_domain" {
  type    = string
  default = null
}
variable "oidc_provider_arn" { type = string }
variable "oidc_provider_url" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}
