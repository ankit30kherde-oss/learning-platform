# ---------------------------------------------------------------------------
# ElastiCache Redis - replaces the dev EventBus's Redis Pub/Sub backing store
# and doubles as the app's cache. In production the event bus itself moves to
# EventBridge/SQS (see the events module); this Redis stays for caching and
# for anything that still wants a fast pub/sub during migration.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
  }
}

locals {
  tags = merge(var.tags, { Module = "cache" })
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.isolated_subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis - reachable only from EKS nodes"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis from EKS nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "random_password" "auth" {
  length  = 32
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description           = "${var.name} cache and event bus"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.node_type

  num_cache_clusters         = var.num_nodes
  automatic_failover_enabled = var.num_nodes > 1
  multi_az_enabled           = var.num_nodes > 1

  subnet_group_name = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.auth.result

  snapshot_retention_limit = 3
  snapshot_window          = "17:00-18:00"

  tags = local.tags
}
