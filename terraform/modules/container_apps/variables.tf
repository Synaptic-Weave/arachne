variable "resource_group_name" {
  description = "Name of the Azure resource group"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "app_name" {
  description = "Base application name"
  type        = string
}

variable "gateway_image" {
  description = "Full container image reference for the gateway"
  type        = string
  default     = ""
}

variable "portal_image" {
  description = "Full container image reference for the portal"
  type        = string
  default     = ""
}

variable "allowed_origins" {
  description = "Comma-separated list of allowed CORS origins for the gateway"
  type        = string
  default     = "https://arachne-ai.com"
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace resource ID"
  type        = string
}

variable "identity_id" {
  description = "Resource ID of the user-assigned managed identity"
  type        = string
}

variable "db_url_secret_id" {
  description = "Key Vault secret ID for DATABASE_URL"
  type        = string
}

variable "master_key_secret_id" {
  description = "Key Vault secret ID for MASTER_KEY"
  type        = string
}

variable "jwt_secret_id" {
  description = "Key Vault secret ID for JWT_SECRET"
  type        = string
}

variable "admin_jwt_secret_id" {
  description = "Key Vault secret ID for ADMIN_JWT_SECRET"
  type        = string
}
