output "cluster_name" { value = module.eks.cluster_name }
output "cluster_endpoint" { value = module.eks.cluster_endpoint }
output "ecr_repository_urls" { value = module.ecr.repository_urls }
output "cloudfront_domain" { value = module.media.cloudfront_domain }
output "secrets_manager_arn" { value = module.secrets.secret_arn }
output "database_endpoint" { value = module.database.cluster_endpoint }

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ap-south-1"
}
