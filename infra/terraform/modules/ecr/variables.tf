variable "services" {
  type = list(string)
  default = [
    "api-gateway", "auth-service", "course-service", "enrollment-service",
    "payment-service", "media-service", "lab-service", "quiz-service",
    "certificate-service", "notification-service", "web",
  ]
}
variable "tags" {
  type    = map(string)
  default = {}
}
