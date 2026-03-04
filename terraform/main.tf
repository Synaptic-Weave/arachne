terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.87"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # BOOTSTRAP (run once before terraform init):
  # az group create --name rg-arachne-tfstate --location eastus
  # az storage account create --name starachnetfstate --resource-group rg-arachne-tfstate --sku Standard_LRS --allow-blob-public-access false
  # az storage container create --name tfstate --account-name starachnetfstate
  backend "azurerm" {
    resource_group_name  = "rg-arachne-tfstate"
    storage_account_name = "starachnetfstate"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}

provider "azuread" {}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "main" {
  name     = "rg-${var.app_name}-${var.environment}"
  location = var.location

  tags = {
    environment = var.environment
    app         = var.app_name
  }
}

module "observability" {
  source = "./modules/observability"

  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  environment         = var.environment
  app_name            = var.app_name
}

module "keyvault" {
  source = "./modules/keyvault"

  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  environment         = var.environment
  app_name            = var.app_name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  deployer_object_id  = data.azurerm_client_config.current.object_id
}

module "database" {
  source = "./modules/database"

  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  environment         = var.environment
  app_name            = var.app_name
  db_admin_login      = var.db_admin_login
  db_admin_password   = module.keyvault.db_admin_password
  db_sku_name         = var.db_sku_name
  db_version          = var.db_version
  db_storage_mb       = var.db_storage_mb
}

# Constructed in root to break circular dep (keyvault ← database FQDN, database ← keyvault password)
resource "azurerm_key_vault_secret" "database_url" {
  name         = "database-url"
  key_vault_id = module.keyvault.key_vault_id
  value        = "postgresql://${var.db_admin_login}:${module.keyvault.db_admin_password}@${module.database.fqdn}:5432/arachne?sslmode=require"
  depends_on   = [module.keyvault]
}

module "container_apps" {
  source = "./modules/container_apps"

  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  environment                = var.environment
  app_name                   = var.app_name
  gateway_image              = var.gateway_image
  portal_image               = var.portal_image
  allowed_origins            = var.allowed_origins
  log_analytics_workspace_id = module.observability.workspace_id
  identity_id                = module.keyvault.identity_id
  db_url_secret_id           = azurerm_key_vault_secret.database_url.versionless_id
  master_key_secret_id       = module.keyvault.master_key_secret_id
  jwt_secret_id              = module.keyvault.jwt_secret_id
  admin_jwt_secret_id        = module.keyvault.admin_jwt_secret_id
}

module "cicd" {
  source = "./modules/cicd"

  resource_group_name = azurerm_resource_group.main.name
  resource_group_id   = azurerm_resource_group.main.id
  environment         = var.environment
  app_name            = var.app_name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  subscription_id     = data.azurerm_client_config.current.subscription_id
  key_vault_id        = module.keyvault.key_vault_id
  depends_on          = [module.keyvault]
}
