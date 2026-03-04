terraform {
  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47"
    }
  }
}

resource "azuread_application" "cicd" {
  display_name = "sp-${var.app_name}-cicd-${var.environment}"
}

resource "azuread_service_principal" "cicd" {
  client_id = azuread_application.cicd.client_id
}

resource "azuread_service_principal_password" "cicd" {
  service_principal_id = azuread_service_principal.cicd.id
  end_date_relative    = "8760h" # 1 year
}

resource "azurerm_role_assignment" "cicd" {
  scope                = var.resource_group_id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.cicd.object_id
}

resource "azurerm_key_vault_secret" "cicd_client_id" {
  name         = "cicd-client-id"
  value        = azuread_application.cicd.client_id
  key_vault_id = var.key_vault_id
}

resource "azurerm_key_vault_secret" "cicd_client_secret" {
  name         = "cicd-client-secret"
  value        = azuread_service_principal_password.cicd.value
  key_vault_id = var.key_vault_id
}

resource "azurerm_key_vault_secret" "cicd_tenant_id" {
  name         = "cicd-tenant-id"
  value        = var.tenant_id
  key_vault_id = var.key_vault_id
}

resource "azurerm_key_vault_secret" "cicd_subscription_id" {
  name         = "cicd-subscription-id"
  value        = var.subscription_id
  key_vault_id = var.key_vault_id
}
