output "gateway_url" {
  description = "Public URL of the gateway Container App"
  value       = module.container_apps.gateway_url
}

output "portal_url" {
  description = "Public URL of the portal Container App"
  value       = module.container_apps.portal_url
}

output "db_fqdn" {
  description = "PostgreSQL server FQDN"
  value       = module.database.fqdn
}

output "key_vault_uri" {
  description = "Azure Key Vault URI"
  value       = module.keyvault.key_vault_uri
}
