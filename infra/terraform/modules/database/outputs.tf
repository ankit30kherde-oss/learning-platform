output "cluster_endpoint" { value = aws_rds_cluster.this.endpoint }
output "reader_endpoint" { value = aws_rds_cluster.this.reader_endpoint }
output "master_password" {
  value     = random_password.master.result
  sensitive = true
}
output "service_passwords" {
  value     = { for k, v in random_password.service : k => v.result }
  sensitive = true
}
output "security_group_id" { value = aws_security_group.db.id }
