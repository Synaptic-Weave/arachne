variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "environment" {
  type = string
}

variable "app_name" {
  type = string
}

variable "dns_zone_name_com" {
  type        = string
  description = "DNS zone for the production site (e.g. arachne-ai.com)"
}

variable "dns_zone_name_dev" {
  type        = string
  description = "DNS zone for the dev preview site (e.g. arachne-ai.dev)"
}

variable "dns_resource_group_name" {
  type        = string
  description = "Resource group containing the DNS zones"
}

variable "key_vault_id" {
  type = string
}

variable "gateway_fqdn" {
  type        = string
  description = "FQDN of the production gateway Container App"
}

variable "portal_fqdn" {
  type        = string
  description = "FQDN of the production portal Container App"
}

variable "dev_gateway_fqdn" {
  type        = string
  description = "FQDN of the dev gateway Container App"
  default     = ""
}

variable "dev_portal_fqdn" {
  type        = string
  description = "FQDN of the dev portal Container App"
  default     = ""
}
