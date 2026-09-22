output "secret_arn" { value = aws_secretsmanager_secret.platform.arn }
output "secret_name" { value = aws_secretsmanager_secret.platform.name }
