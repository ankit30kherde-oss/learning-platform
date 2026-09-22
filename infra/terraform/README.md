# Terraform

## Layout

```
modules/        reusable building blocks, no environment-specific values
environments/   one directory per environment, each with its own state
```

Each environment has its own backend and its own state file. There is no
workspace switching: `terraform apply` in `environments/production` can only
ever touch production, which removes the single most common way people destroy
the wrong environment.

## State

State lives in S3 with versioning and encryption, and uses S3 native state
locking (`use_lockfile = true`, Terraform 1.10+) rather than a DynamoDB table.
The bucket is created once, by hand, before the first apply - a chicken-and-egg
problem every Terraform setup has:

```bash
aws s3api create-bucket --bucket lp-terraform-state --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-bucket-versioning --bucket lp-terraform-state \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket lp-terraform-state \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket lp-terraform-state \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

## Order of operations

```bash
cd infra/terraform/environments/staging
terraform init
terraform plan -out=tf.plan     # read it; every line
terraform apply tf.plan
```

Expect 20-30 minutes for the first apply - EKS and Aurora dominate that.

## Cost warning

This is a production-shaped stack. Running it continuously in ap-south-1 costs
roughly USD 350-500 a month for staging and more for production, before any
traffic. `terraform destroy` when you are only exploring. Nothing in the
Codespaces workflow needs any of it.
