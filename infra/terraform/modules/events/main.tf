# ---------------------------------------------------------------------------
# Production event bus: EventBridge for routing, SQS for per-consumer delivery.
#
# This replaces the dev EventBus's Redis Pub/Sub. The interface each service
# codes against (packages/shared/src/event-bus.ts) does not change; only the
# implementation behind `publish`/`subscribe` does, driven by which env vars
# are set. Redis Pub/Sub has no replay and no dead-letter queue - fine for a
# single Codespace, not for a system where a lost "payment.completed" event
# means someone paid and never got enrolled.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
  }
}

locals {
  tags = merge(var.tags, { Module = "events" })
}

resource "aws_cloudwatch_event_bus" "this" {
  name = "${var.name}-events"
  tags = local.tags
}

# One rule per (source-agnostic) event name, one queue per consumer. A service
# that only cares about payment.completed does not receive, and pay to ignore,
# every enrollment.created message too.
resource "aws_sqs_queue" "dlq" {
  for_each                  = var.consumers
  name                      = "${var.name}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days - long enough to investigate before it's gone
  tags                      = local.tags
}

resource "aws_sqs_queue" "queue" {
  for_each                   = var.consumers
  name                        = "${var.name}-${each.key}"
  visibility_timeout_seconds  = 60
  message_retention_seconds   = 345600 # 4 days
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount      = 5
  })
  tags = local.tags
}

resource "aws_sqs_queue_policy" "queue" {
  for_each  = aws_sqs_queue.queue
  queue_url = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = each.value.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.rule[each.key].arn } }
    }]
  })
}

resource "aws_cloudwatch_event_rule" "rule" {
  for_each       = var.consumers
  name           = "${var.name}-${each.key}"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern = jsonencode({
    "detail-type" = each.value.event_names
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "target" {
  for_each       = var.consumers
  rule           = aws_cloudwatch_event_rule.rule[each.key].name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  arn            = aws_sqs_queue.queue[each.key].arn
}
