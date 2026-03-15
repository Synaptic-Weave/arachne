output "static_web_app_id" {
  value = azurerm_static_web_app.dev_site.id
}

output "static_web_app_default_hostname" {
  value = azurerm_static_web_app.dev_site.default_host_name
}

output "deploy_token" {
  value     = azurerm_static_web_app.dev_site.api_key
  sensitive = true
}
