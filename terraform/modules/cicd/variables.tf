variable "resource_group_name" {
  description = "Name of the Azure resource group"
  type        = string
}

variable "resource_group_id" {
  description = "Resource ID of the Azure resource group (used to scope role assignment)"
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

variable "tenant_id" {
  description = "Azure tenant ID"
  type        = string
}

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "key_vault_id" {
  description = "Resource ID of the Key Vault to store CI/CD credentials"
  type        = string
}
