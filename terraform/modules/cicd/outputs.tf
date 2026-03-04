output "client_id" {
  description = "Client ID of the CI/CD service principal"
  value       = azuread_application.cicd.client_id
}

output "sp_object_id" {
  description = "Object ID of the CI/CD service principal"
  value       = azuread_service_principal.cicd.object_id
}
