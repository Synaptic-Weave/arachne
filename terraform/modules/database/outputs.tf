output "fqdn" {
  description = "PostgreSQL server FQDN"
  value       = azurerm_postgresql_flexible_server.db.fqdn
}

output "server_id" {
  description = "PostgreSQL server resource ID"
  value       = azurerm_postgresql_flexible_server.db.id
}
