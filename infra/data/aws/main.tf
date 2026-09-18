terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.12.0" }
  }
  backend "s3" {}
}
variable "name" { type = string }
variable "region" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
provider "aws" { region = var.region }
resource "aws_db_subnet_group" "database" {
  name       = var.name
  subnet_ids = var.subnet_ids
}
resource "aws_db_instance" "database" {
  identifier                  = var.name
  engine                      = "postgres"
  engine_version              = "16"
  instance_class              = "db.t4g.small"
  allocated_storage           = 20
  storage_encrypted           = true
  db_name                     = "platform"
  username                    = "platform"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.database.name
  vpc_security_group_ids      = var.security_group_ids
  publicly_accessible         = false
  multi_az                    = true
  backup_retention_period     = 14
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name}-final"
  lifecycle { prevent_destroy = true }
}
output "endpoint" { value = aws_db_instance.database.address }
output "secret_arn" { value = aws_db_instance.database.master_user_secret[0].secret_arn }
