# ---------------------------------------------------------------------------
# EKS.
#
# Two managed node groups, not one:
#   platform - runs every application pod. Regular on-demand nodes.
#   labs     - tainted, and ONLY lab-service's generated namespaces tolerate the
#              taint. Student containers never land on the same kernel as
#              payment-service.
#
# The API server endpoint is private-only in production (var.public_api_access
# defaults to false): the cluster is administered from CI's OIDC role and from
# a bastion/VPN, never from the open internet.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
  }
}

locals {
  tags = merge(var.tags, { Module = "eks" })
}

resource "aws_kms_key" "eks" {
  description             = "${var.cluster_name} secrets encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = local.tags
}

resource "aws_iam_role" "cluster" {
  name = "${var.cluster_name}-cluster"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  ])
  role       = aws_iam_role.cluster.name
  policy_arn = each.value
}

resource "aws_security_group" "cluster" {
  name        = "${var.cluster_name}-cluster"
  description = "EKS control plane"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_eks_cluster" "this" {
  name                      = var.cluster_name
  role_arn                  = aws_iam_role.cluster.arn
  version                   = var.kubernetes_version
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    security_group_ids      = [aws_security_group.cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = var.public_api_access
    public_access_cidrs     = var.public_api_access ? var.public_api_cidrs : null
  }

  encryption_config {
    provider { key_arn = aws_kms_key.eks.arn }
    resources = ["secrets"]
  }

  access_config {
    authentication_mode = "API"
  }

  tags = local.tags
  depends_on = [
    aws_iam_role_policy_attachment.cluster,
    aws_cloudwatch_log_group.cluster,
  ]
}

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${var.cluster_name}/cluster"
  retention_in_days = 30
  tags              = local.tags
}

# ---------------------------------------------------------------- node roles

resource "aws_iam_role" "node" {
  name = "${var.cluster_name}-node"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# --------------------------------------------------------- platform node group

resource "aws_eks_node_group" "platform" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "platform"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.platform_instance_types
  capacity_type   = var.platform_capacity_type

  scaling_config {
    min_size     = var.platform_min_size
    max_size     = var.platform_max_size
    desired_size = var.platform_desired_size
  }

  update_config {
    max_unavailable_percentage = 33
  }

  labels = { "lp.io/workload" = "platform" }

  tags = local.tags
  depends_on = [
    aws_iam_role_policy_attachment.node,
  ]

  lifecycle {
    # Cluster Autoscaler / Karpenter owns desired_size at runtime; Terraform
    # should not fight it back to the value in this file every apply.
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# -------------------------------------------------------------- lab node group

resource "aws_eks_node_group" "labs" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "labs"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.lab_instance_types
  capacity_type   = "ON_DEMAND" # spot interruption mid-lab is a bad student experience

  scaling_config {
    min_size     = var.lab_min_size
    max_size     = var.lab_max_size
    desired_size = var.lab_min_size
  }

  labels = { "lp.io/workload" = "lab" }

  taint {
    key    = "lp.io/lab"
    value  = "true"
    effect = "NO_SCHEDULE"
  }

  tags = local.tags
  depends_on = [
    aws_iam_role_policy_attachment.node,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# ------------------------------------------------------------------- add-ons

resource "aws_eks_addon" "this" {
  for_each = {
    vpc-cni    = var.vpc_cni_version
    coredns    = var.coredns_version
    kube-proxy = var.kube_proxy_version
    aws-ebs-csi-driver = var.ebs_csi_version
  }
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = each.key
  addon_version                = each.value
  resolve_conflicts_on_update = "OVERWRITE"
  depends_on                  = [aws_eks_node_group.platform]
}

# ------------------------------------------------------------- OIDC for IRSA

data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
  tags            = local.tags
}
