# ---------------------------------------------------------------------------
# WAFv2 in front of the ALB. Managed rule groups cover the OWASP-shaped stuff
# (SQLi, known bad inputs, known bad IPs); the custom rules cover the two
# routes we know are attacked in practice - login and checkout.
# ---------------------------------------------------------------------------

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.82" }
  }
}

locals {
  tags = merge(var.tags, { Module = "waf" })
}

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name}-waf"
  description = "Edge protection for ${var.name}"
  scope       = "REGIONAL" # ALB, not CloudFront - the media CDN has its own signed-URL protection

  default_action { allow {} }

  rule {
    name     = "aws-common"
    priority = 0
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 1
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-sqli"
    priority = 2
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "sqli"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 3
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  # Login already has its own account lockout inside auth-service; this rate
  # limit is the layer that stops a distributed credential-stuffing run from
  # ever reaching the application to trigger those lockouts one account at a time.
  rule {
    name     = "rate-limit-login"
    priority = 10
    action { block {} }
    statement {
      rate_based_statement {
        limit              = 120
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string = "/api/auth/login"
            field_to_match { uri_path {} }
            text_transformation { priority = 0, type = "NONE" }
            positional_constraint = "STARTS_WITH"
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-login"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-checkout"
    priority = 11
    action { block {} }
    statement {
      rate_based_statement {
        limit              = 60
        aggregate_key_type = "IP"
        scope_down_statement {
          byte_match_statement {
            search_string = "/api/payments/orders"
            field_to_match { uri_path {} }
            text_transformation { priority = 0, type = "NONE" }
            positional_constraint = "STARTS_WITH"
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-checkout"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-waf"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}
