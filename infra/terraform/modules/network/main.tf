# ---------------------------------------------------------------------------
# VPC.
#
# Three tiers across three AZs:
#   public   - ALB and NAT gateways only
#   private  - EKS nodes and every application pod
#   isolated - Aurora and ElastiCache, with NO route to a NAT gateway
#
# The isolated tier is the point. A compromised pod cannot exfiltrate a
# database dump to the internet because the subnet the database lives in has no
# path out, and the pod's own egress is restricted by NetworkPolicy on top.
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
  }
}

locals {
  azs  = slice(data.aws_availability_zones.available.names, 0, 3)
  tags = merge(var.tags, { Module = "network" })
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = 3
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr_block, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false # the ALB gets its own EIPs; nodes never live here
  tags = merge(local.tags, {
    Name                                        = "${var.name}-public-${local.azs[count.index]}"
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index + 3)
  availability_zone = local.azs[count.index]
  tags = merge(local.tags, {
    Name                                        = "${var.name}-private-${local.azs[count.index]}"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_subnet" "isolated" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index + 6)
  availability_zone = local.azs[count.index]
  tags              = merge(local.tags, { Name = "${var.name}-isolated-${local.azs[count.index]}" })
}

# One NAT per AZ in production (no cross-AZ data charges, no single point of
# failure); one shared NAT in staging, because three NATs to serve a staging
# environment is USD 100/month of pure ceremony.
resource "aws_eip" "nat" {
  count  = var.single_nat_gateway ? 1 : 3
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = var.single_nat_gateway ? 1 : 3
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = 3
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
  }
  tags = merge(local.tags, { Name = "${var.name}-private-${count.index}" })
}

resource "aws_route_table_association" "private" {
  count          = 3
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# No default route at all: this is what "isolated" means.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-isolated" })
}

resource "aws_route_table_association" "isolated" {
  count          = 3
  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

# VPC endpoints keep S3, ECR and Secrets Manager traffic off the NAT gateway.
# This is both a security win (no internet path needed for pulls or secret
# reads) and the single biggest NAT cost reduction available.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.isolated.id])
  tags              = merge(local.tags, { Name = "${var.name}-s3" })
}

resource "aws_security_group" "endpoints" {
  name        = "${var.name}-vpce"
  description = "Interface VPC endpoints"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr_block]
  }

  egress {
    description = "Return traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.cidr_block]
  }

  tags = local.tags
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset([
    "ecr.api", "ecr.dkr", "secretsmanager", "logs", "sts", "kms", "sqs", "events",
  ])

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "${var.name}-${each.value}" })
}

# Flow logs: the only way to answer "what talked to what" after an incident.
resource "aws_flow_log" "this" {
  vpc_id               = aws_vpc.this.id
  traffic_type         = "REJECT" # accepted traffic is high volume, low signal
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow.arn
  iam_role_arn          = aws_iam_role.flow.arn
  tags                  = local.tags
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/aws/vpc/${var.name}/flow-logs"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_iam_role" "flow" {
  name = "${var.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "flow" {
  role = aws_iam_role.flow.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
    }]
  })
}
