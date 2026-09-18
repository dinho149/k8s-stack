terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.49.0" }
  }
  backend "gcs" {}
}
variable "name" { type = string }
variable "project" { type = string }
variable "region" { type = string }
variable "network_id" { type = string }
provider "google" {
  project = var.project
  region  = var.region
}
resource "google_sql_database_instance" "database" {
  name                = var.name
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  settings {
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL"
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }
  lifecycle { prevent_destroy = true }
}
resource "google_sql_database" "platform" {
  name     = "platform"
  instance = google_sql_database_instance.database.name
}
output "connection_name" { value = google_sql_database_instance.database.connection_name }
