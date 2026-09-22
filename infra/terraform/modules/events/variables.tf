variable "name" { type = string }

# Maps a consuming service to the event names it wants delivered.
# e.g. { notification-service = { event_names = ["payment.completed", "payment.failed"] } }
variable "consumers" {
  type = map(object({
    event_names = list(string)
  }))
}

variable "tags" {
  type    = map(string)
  default = {}
}
