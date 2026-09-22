output "event_bus_name" { value = aws_cloudwatch_event_bus.this.name }
output "event_bus_arn" { value = aws_cloudwatch_event_bus.this.arn }
output "queue_urls" { value = { for k, v in aws_sqs_queue.queue : k => v.url } }
output "queue_arns" { value = { for k, v in aws_sqs_queue.queue : k => v.arn } }
