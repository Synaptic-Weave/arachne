resource "azurerm_postgresql_flexible_server" "db" {
  name                         = "psql-${var.app_name}-${var.environment}"
  resource_group_name          = var.resource_group_name
  location                     = var.location
  administrator_login          = var.db_admin_login
  administrator_password       = var.db_admin_password
  sku_name                     = var.db_sku_name
  version                      = var.db_version
  storage_mb                   = var.db_storage_mb
  zone                         = "1"
  backup_retention_days        = 7
  geo_redundant_backup_enabled = false

  tags = {
    environment = var.environment
    app         = var.app_name
  }
}

resource "azurerm_postgresql_flexible_server_configuration" "pgvector" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.db.id
  value     = "VECTOR"
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "allow_azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.db.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_database" "arachne" {
  name      = "arachne"
  server_id = azurerm_postgresql_flexible_server.db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
