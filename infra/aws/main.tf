terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.12.0" }
  }
  backend "s3" {}
}
provider "aws" { region = var.region }
data "aws_availability_zones" "available" { state = "available" }
variable "name" { type = string }
variable "region" { type = string }
variable "kubernetes_version" { default = "1.33" }
variable "node_type" { default = "t3.large" }
variable "node_count" { default = 2 }
variable "public_api_cidrs" {
  type    = list(string)
  default = []
}
variable "bedrock_model_arns" {
  type = list(string)
  validation {
    condition     = length(var.bedrock_model_arns) > 0 && !contains(var.bedrock_model_arns, "*")
    error_message = "Provide explicit foundation-model and inference-profile ARNs."
  }
}
resource "aws_vpc" "platform" {
  cidr_block           = "10.60.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = var.name, "stack.platform/managed" = "true" }
}
resource "aws_internet_gateway" "platform" { vpc_id = aws_vpc.platform.id }
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.platform.id
  cidr_block              = cidrsubnet(aws_vpc.platform.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false
  tags                    = { "kubernetes.io/role/elb" = "1" }
}
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.platform.id
  cidr_block        = cidrsubnet(aws_vpc.platform.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { "kubernetes.io/role/internal-elb" = "1" }
}
resource "aws_eip" "nat" { domain = "vpc" }
resource "aws_nat_gateway" "platform" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.platform]
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.platform.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.platform.id
  }
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.platform.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.platform.id
  }
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}
resource "aws_eks_cluster" "platform" {
  name     = var.name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version
  access_config { authentication_mode = "API_AND_CONFIG_MAP" }
  vpc_config {
    subnet_ids              = aws_subnet.private[*].id
    endpoint_private_access = true
    endpoint_public_access  = length(var.public_api_cidrs) > 0
    public_access_cidrs     = var.public_api_cidrs
  }
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  depends_on                = [aws_iam_role_policy_attachment.cluster]
}
resource "aws_iam_role" "nodes" {
  name               = "${var.name}-nodes"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "nodes" {
  for_each   = toset(["AmazonEKSWorkerNodePolicy", "AmazonEC2ContainerRegistryPullOnly", "AmazonEKS_CNI_Policy"])
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:aws:iam::aws:policy/${each.value}"
}
resource "aws_launch_template" "nodes" {
  name_prefix = "${var.name}-"
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
}
resource "aws_eks_node_group" "platform" {
  cluster_name    = aws_eks_cluster.platform.name
  node_group_name = "platform"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = [var.node_type]
  launch_template {
    id      = aws_launch_template.nodes.id
    version = aws_launch_template.nodes.latest_version
  }
  scaling_config {
    desired_size = var.node_count
    min_size     = var.node_count
    max_size     = var.node_count + 3
  }
  depends_on = [aws_iam_role_policy_attachment.nodes]
}
resource "aws_iam_openid_connect_provider" "cluster" {
  url            = aws_eks_cluster.platform.identity[0].oidc[0].issuer
  client_id_list = ["sts.amazonaws.com"]
}
locals { oidc_host = replace(aws_iam_openid_connect_provider.cluster.url, "https://", "") }
resource "aws_iam_role" "agent" {
  name               = "${var.name}-agent"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Federated = aws_iam_openid_connect_provider.cluster.arn }, Action = "sts:AssumeRoleWithWebIdentity", Condition = { StringEquals = { "${local.oidc_host}:sub" = "system:serviceaccount:platform:stack-agent", "${local.oidc_host}:aud" = "sts.amazonaws.com" } } }] })
}
resource "aws_iam_role_policy" "agent" {
  role   = aws_iam_role.agent.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource = var.bedrock_model_arns }] })
}
output "cluster_name" { value = aws_eks_cluster.platform.name }
output "agent_role_arn" { value = aws_iam_role.agent.arn }
output "private_subnets" { value = aws_subnet.private[*].id }
output "vpc_id" { value = aws_vpc.platform.id }
