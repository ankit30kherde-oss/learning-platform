# ---------------------------------------------------------------------------
# One repository per service, with scan-on-push and a lifecycle policy that
# keeps the last N tagged images. Untagged images (build cache layers pushed
# without a tag) expire in a day - they are waste, not history.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
  }
}

locals {
  tags = merge(var.tags, { Module = "ecr" })
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(var.services)
  name                 = "lp/${each.value}"
  image_tag_mutability = "IMMUTABLE" # a tag, once pushed, never points at different bytes

  image_scanning_configuration { scan_on_push = true }

  encryption_configuration { encryption_type = "KMS" }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 20 tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPatternList = ["*"]
          countType     = "imageCountMoreThan"
          countNumber   = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
