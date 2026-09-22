variable "cluster_name" { type = string }
variable "kubernetes_version" {
  type    = string
  default = "1.31"
}
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }

variable "public_api_access" {
  description = "Expose the API server publicly. Leave false except for a quick local demo cluster."
  type        = bool
  default     = false
}
variable "public_api_cidrs" {
  type    = list(string)
  default = []
}

variable "platform_instance_types" {
  type    = list(string)
  default = ["m6i.large"]
}
variable "platform_capacity_type" {
  type    = string
  default = "ON_DEMAND"
}
variable "platform_min_size" {
  type    = number
  default = 3
}
variable "platform_max_size" {
  type    = number
  default = 12
}
variable "platform_desired_size" {
  type    = number
  default = 3
}

variable "lab_instance_types" {
  type    = list(string)
  default = ["m6i.xlarge"]
}
variable "lab_min_size" {
  type    = number
  default = 1
}
variable "lab_max_size" {
  type    = number
  default = 10
}

variable "vpc_cni_version" {
  type    = string
  default = null
}
variable "coredns_version" {
  type    = string
  default = null
}
variable "kube_proxy_version" {
  type    = string
  default = null
}
variable "ebs_csi_version" {
  type    = string
  default = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
