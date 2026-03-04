output "gateway_url" {
  description = "Public URL of the gateway Container App"
  value       = "https://${azurerm_container_app.gateway.ingress[0].fqdn}"
}

output "portal_url" {
  description = "Public URL of the portal Container App"
  value       = "https://${azurerm_container_app.portal.ingress[0].fqdn}"
}
