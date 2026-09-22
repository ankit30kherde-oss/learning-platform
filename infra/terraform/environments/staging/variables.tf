variable "razorpay_key_id" {
  type    = string
  default = "rzp_test_xxxxxxxxxxxx"
}
variable "razorpay_key_secret" {
  type      = string
  sensitive = true
}
variable "razorpay_webhook_secret" {
  type      = string
  sensitive = true
}
