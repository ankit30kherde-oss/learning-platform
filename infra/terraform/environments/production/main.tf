# ---------------------------------------------------------------------------
# Staging. Smaller numbers than production, same modules, same shape - see
# infra/terraform/README.md for why that similarity is the point.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.10.0"

  backend "s3" {
    bucket       = "lp-terraform-state"
    key          = "production/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true # S3-native locking (Terraform 1.10+); no DynamoDB table needed
  }

  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.82" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
    tls    = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}

provider "aws" {
  region = local.region
  default_tags {
    tags = local.tags
  }
}

locals {
  name        = "lp-production"
  environment = "production"
  region      = "ap-south-1"
  tags = {
    Environment = local.environment
    Project     = "learning-platform"
    ManagedBy   = "terraform"
  }
}

module "network" {
  source             = "../../modules/network"
  name               = local.name
  region             = local.region
  cluster_name       = local.name
  single_nat_gateway = false # production: one NAT per AZ, no shared blast radius
  tags               = local.tags
}

module "eks" {
  source              = "../../modules/eks"
  cluster_name        = local.name
  vpc_id              = module.network.vpc_id
  private_subnet_ids  = module.network.private_subnet_ids
  public_api_access   = false

  platform_instance_types = ["m6i.large"]
  platform_min_size       = 3
  platform_max_size       = 15
  platform_desired_size   = 3

  lab_instance_types = ["m6i.xlarge"]
  lab_min_size        = 2
  lab_max_size        = 15

  tags = local.tags
}

module "database" {
  source                  = "../../modules/database"
  name                     = local.name
  vpc_id                   = module.network.vpc_id
  isolated_subnet_ids      = module.network.isolated_subnet_ids
  node_security_group_id   = module.eks.node_security_group_id
  min_acu                  = 1
  max_acu                  = 16
  reader_count             = 1
  deletion_protection      = true
  tags                     = local.tags
}

module "cache" {
  source                  = "../../modules/cache"
  name                     = local.name
  vpc_id                   = module.network.vpc_id
  isolated_subnet_ids      = module.network.isolated_subnet_ids
  node_security_group_id   = module.eks.node_security_group_id
  node_type                = "cache.r7g.large"
  num_nodes                = 2
  tags                     = local.tags
}

module "ecr" {
  source = "../../modules/ecr"
  tags   = local.tags
}

module "media" {
  source              = "../../modules/media"
  name                = local.name
  bucket_name         = "${local.name}-media"
  app_origins         = ["https://devopsacademy.example.com"]
  oidc_provider_arn   = module.eks.oidc_provider_arn
  oidc_provider_url   = module.eks.oidc_provider_url
  tags                = local.tags
}

module "events" {
  source = "../../modules/events"
  name   = local.name
  consumers = {
    notification-service = {
      event_names = [
        "enrollment.created", "payment.completed", "payment.failed",
        "payment.refunded", "progress.course_completed", "certificate.issued",
      ]
    }
    certificate-service = {
      event_names = ["progress.course_completed"]
    }
  }
  tags = local.tags
}

module "waf" {
  source = "../../modules/waf"
  name   = local.name
  tags   = local.tags
}

module "secrets" {
  source                      = "../../modules/secrets"
  environment                  = local.environment
  database_endpoint            = module.database.cluster_endpoint
  database_service_passwords   = module.database.service_passwords
  redis_endpoint                = module.cache.primary_endpoint
  redis_auth_token               = module.cache.auth_token
  razorpay_key_id                = var.razorpay_key_id
  razorpay_key_secret            = var.razorpay_key_secret
  razorpay_webhook_secret        = var.razorpay_webhook_secret
  cloudfront_domain              = module.media.cloudfront_domain
  cloudfront_key_pair_id         = module.media.cloudfront_key_pair_id
  cloudfront_private_key_pem     = module.media.cloudfront_private_key_pem
  media_bucket_name              = module.media.bucket_name
  tags                            = local.tags
}
