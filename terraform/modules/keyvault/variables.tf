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

variable "tenant_id" {
  description = "Azure tenant ID — from azurerm_client_config"
  type        = string
}

variable "deployer_object_id" {
  description = "Object ID of the principal running terraform — from azurerm_client_config"
  type        = string
}
