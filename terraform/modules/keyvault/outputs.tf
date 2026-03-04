output "identity_id" {
  description = "Resource ID of the user-assigned managed identity"
  value       = azurerm_user_assigned_identity.app_identity.id
}

output "identity_principal_id" {
  description = "Principal ID of the user-assigned managed identity"
  value       = azurerm_user_assigned_identity.app_identity.principal_id
}

output "db_admin_password" {
  description = "Auto-generated PostgreSQL admin password"
  value       = random_password.db_admin_password.result
  sensitive   = true
}

output "db_admin_password_secret_id" {
  description = "Versionless Key Vault secret ID for the DB admin password"
  value       = azurerm_key_vault_secret.db_admin_password.versionless_id
}

output "master_key_secret_id" {
  description = "Versionless Key Vault secret ID for the master key"
  value       = azurerm_key_vault_secret.master_key.versionless_id
}

output "jwt_secret_id" {
  description = "Versionless Key Vault secret ID for the JWT secret"
  value       = azurerm_key_vault_secret.jwt_secret.versionless_id
}

output "admin_jwt_secret_id" {
  description = "Versionless Key Vault secret ID for the admin JWT secret"
  value       = azurerm_key_vault_secret.admin_jwt_secret.versionless_id
}

output "key_vault_id" {
  description = "Resource ID of the Key Vault"
  value       = azurerm_key_vault.main.id
}

output "key_vault_uri" {
  description = "URI of the Key Vault"
  value       = azurerm_key_vault.main.vault_uri
}
