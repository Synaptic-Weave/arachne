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
  description = "FQDN of the gateway Container App for this environment"
}

variable "portal_fqdn" {
  type        = string
  description = "FQDN of the portal Container App for this environment"
}
