variable "name" { type = string }
variable "vpc_id" { type = string }
variable "isolated_subnet_ids" { type = list(string) }
variable "node_security_group_id" { type = string }

variable "engine_version" {
  type    = string
  default = "16.4"
}
variable "min_acu" {
  description = "Minimum Aurora Capacity Units. 0.5 lets staging idle cheaply."
  type        = number
  default     = 0.5
}
variable "max_acu" {
  type    = number
  default = 4
}
variable "reader_count" {
  type    = number
  default = 0
}
variable "backup_retention_days" {
  type    = number
  default = 7
}
variable "deletion_protection" {
  type    = bool
  default = false
}
variable "tags" {
  type    = map(string)
  default = {}
}
