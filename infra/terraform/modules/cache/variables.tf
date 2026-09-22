variable "name" { type = string }
variable "vpc_id" { type = string }
variable "isolated_subnet_ids" { type = list(string) }
variable "node_security_group_id" { type = string }
variable "node_type" {
  type    = string
  default = "cache.t4g.small"
}
variable "num_nodes" {
  type    = number
  default = 1
}
variable "tags" {
  type    = map(string)
  default = {}
}
