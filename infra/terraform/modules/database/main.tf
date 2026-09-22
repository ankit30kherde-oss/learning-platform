# ---------------------------------------------------------------------------
# Aurora PostgreSQL Serverless v2, one cluster shared by every service.
#
# "Database per service" is enforced at the database level (nine separate
# databases, nine separate app users, no cross-database grants) rather than at
# the cluster level. A cluster per service would mean nine sets of Aurora
# minimums to pay for; nine databases on one cluster keeps the isolation that
# actually matters - no service's ORM can see another's tables - without nine
# times the idle cost. Splitting onto separate clusters later, if one service's
# load genuinely needs it, is a snapshot-and-restore away, not a rewrite.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.82" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  tags = merge(var.tags, { Module = "database" })
  # Matches infra/docker/postgres/init-databases.sh so dev and prod agree on
  # exactly which databases exist.
  databases = [
    "auth_db", "course_db", "enrollment_db", "payment_db", "media_db",
    "lab_db", "quiz_db", "certificate_db", "notification_db",
  ]
}

resource "aws_kms_key" "db" {
  description             = "${var.name} Aurora encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = local.tags
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.isolated_subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Aurora - reachable only from the app node security group"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from EKS nodes"
    from_port       = 5432
    to_port         = 5432
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

resource "random_password" "master" {
  length  = 32
  special = false # simplifies embedding in a connection string; still 32 chars of entropy
}

resource "aws_rds_cluster" "this" {
  cluster_identifier     = var.name
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  engine_version         = var.engine_version
  database_name          = "platform"
  master_username        = "lp_admin"
  master_password        = random_password.master.result
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  storage_encrypted      = true
  kms_key_id             = aws_kms_key.db.arn

  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = "17:00-18:00" # 22:30-23:30 IST, low traffic
  preferred_maintenance_window = "sun:18:00-sun:19:00"

  # Serverless v2 scales the compute of every instance in the cluster between
  # these bounds based on load - no manual instance-class guessing, and
  # staging can float near the floor most of the day.
  serverlessv2_scaling_configuration {
    min_capacity = var.min_acu
    max_capacity = var.max_acu
  }

  deletion_protection = var.deletion_protection
  skip_final_snapshot = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-final" : null

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = local.tags
}

resource "aws_rds_cluster_instance" "writer" {
  identifier          = "${var.name}-writer"
  cluster_identifier  = aws_rds_cluster.this.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.this.engine
  engine_version      = aws_rds_cluster.this.engine_version
  publicly_accessible = false
  tags                = local.tags
}

resource "aws_rds_cluster_instance" "reader" {
  count               = var.reader_count
  identifier          = "${var.name}-reader-${count.index}"
  cluster_identifier  = aws_rds_cluster.this.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.this.engine
  engine_version      = aws_rds_cluster.this.engine_version
  publicly_accessible = false
  tags                = local.tags
}

# ----------------------------------------------------- per-service databases
#
# Terraform's postgresql provider needs network access to the cluster at apply
# time, which from a laptop it does not have (the cluster lives in an isolated
# subnet on purpose). So this step - CREATE DATABASE and CREATE USER for each
# service - runs from inside the cluster of the deploying CI job via a
# Kubernetes Job, using the SQL this module renders. See
# infra/kubernetes/jobs/provision-databases.yaml.
resource "local_sensitive_file" "provision_sql" {
  filename = "${path.module}/generated/provision-databases.sql"
  content = join("\n\n", [
    for db in local.databases : <<-SQL
      SELECT 'CREATE DATABASE ${db}' WHERE NOT EXISTS
        (SELECT FROM pg_database WHERE datname = '${db}')\gexec
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${replace(db, "_db", "")}_app') THEN
          CREATE ROLE ${replace(db, "_db", "")}_app LOGIN PASSWORD '${random_password.service[db].result}';
        END IF;
      END $$;
      GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${replace(db, "_db", "")}_app;
    SQL
  ])
}

resource "random_password" "service" {
  for_each = toset(local.databases)
  length   = 32
  special  = false
}
