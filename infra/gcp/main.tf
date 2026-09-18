terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.49.0" }
  }
  backend "gcs" {}
}
variable "project" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "node_type" { default = "e2-standard-4" }
variable "nodes_per_zone" { default = 1 }
variable "authorized_networks" {
  type    = list(string)
  default = []
}
provider "google" {
  project = var.project
  region  = var.region
}
resource "google_project_service" "apis" {
  for_each           = toset(["container.googleapis.com", "compute.googleapis.com", "aiplatform.googleapis.com", "iamcredentials.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}
resource "google_compute_network" "platform" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}
resource "google_compute_subnetwork" "platform" {
  name                     = var.name
  network                  = google_compute_network.platform.id
  region                   = var.region
  ip_cidr_range            = "10.70.0.0/20"
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.72.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.76.0.0/20"
  }
}
resource "google_compute_router" "platform" {
  name    = var.name
  network = google_compute_network.platform.id
}
resource "google_compute_router_nat" "platform" {
  name                               = var.name
  router                             = google_compute_router.platform.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
resource "google_service_account" "nodes" { account_id = "${var.name}-nodes" }
resource "google_project_iam_member" "nodes" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/artifactregistry.reader"])
  project  = var.project
  role     = each.value
  member   = "serviceAccount:${google_service_account.nodes.email}"
}
resource "google_container_cluster" "platform" {
  name                     = var.name
  location                 = var.region
  network                  = google_compute_network.platform.id
  subnetwork               = google_compute_subnetwork.platform.id
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = true
  datapath_provider        = "ADVANCED_DATAPATH"
  release_channel { channel = "REGULAR" }
  workload_identity_config { workload_pool = "${var.project}.svc.id.goog" }
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = length(var.authorized_networks) == 0
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }
  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.authorized_networks
      content { cidr_block = cidr_blocks.value }
    }
  }
  depends_on = [google_project_service.apis]
}
resource "google_container_node_pool" "platform" {
  name       = "platform"
  cluster    = google_container_cluster.platform.name
  location   = var.region
  node_count = var.nodes_per_zone
  autoscaling {
    min_node_count = var.nodes_per_zone
    max_node_count = var.nodes_per_zone + 2
  }
  node_config {
    machine_type    = var.node_type
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    workload_metadata_config { mode = "GKE_METADATA" }
    shielded_instance_config { enable_secure_boot = true }
  }
}
resource "google_service_account" "agent" { account_id = "${var.name}-agent" }
resource "google_project_iam_member" "agent" {
  project = var.project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.agent.email}"
}
resource "google_service_account_iam_member" "agent" {
  service_account_id = google_service_account.agent.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project}.svc.id.goog[platform/dogfood-agent]"
}
output "cluster_name" { value = google_container_cluster.platform.name }
output "agent_service_account" { value = google_service_account.agent.email }
