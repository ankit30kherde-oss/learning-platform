variable "name" {
  description = "Prefix for every resource name"
  type        = string
}

variable "region" {
  type = string
}

variable "cidr_block" {
  description = "VPC CIDR. /16 leaves room for three tiers across three AZs."
  type        = string
  default     = "10.0.0.0/16"
}

variable "cluster_name" {
  description = "EKS cluster name, used for subnet discovery tags"
  type        = string
}

variable "single_nat_gateway" {
  description = "One NAT instead of one per AZ. Cheaper, less available - staging only."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
