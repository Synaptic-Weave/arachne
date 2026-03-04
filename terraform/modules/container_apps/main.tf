resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${var.app_name}-${var.environment}"
  location                   = var.location
  resource_group_name        = var.resource_group_name
  log_analytics_workspace_id = var.log_analytics_workspace_id

  tags = {
    environment = var.environment
    app         = var.app_name
  }
}

resource "azurerm_container_app" "gateway" {
  name                         = "ca-${var.app_name}-gateway-${var.environment}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  secret {
    name                = "database-url"
    key_vault_secret_id = var.db_url_secret_id
    identity            = var.identity_id
  }

  secret {
    name                = "master-key"
    key_vault_secret_id = var.master_key_secret_id
    identity            = var.identity_id
  }

  secret {
    name                = "jwt-secret"
    key_vault_secret_id = var.jwt_secret_id
    identity            = var.identity_id
  }

  secret {
    name                = "admin-jwt-secret"
    key_vault_secret_id = var.admin_jwt_secret_id
    identity            = var.identity_id
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "gateway"
      image  = var.gateway_image != "" ? var.gateway_image : "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "MASTER_KEY"
        secret_name = "master-key"
      }

      env {
        name        = "JWT_SECRET"
        secret_name = "jwt-secret"
      }

      env {
        name        = "ADMIN_JWT_SECRET"
        secret_name = "admin-jwt-secret"
      }

      env {
        name  = "SIGNUPS_ENABLED"
        value = "false"
      }

      env {
        name  = "ALLOWED_ORIGINS"
        value = var.allowed_origins
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  tags = {
    environment = var.environment
    app         = var.app_name
    component   = "gateway"
  }
}

resource "azurerm_container_app" "portal" {
  name                         = "ca-${var.app_name}-portal-${var.environment}"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"

  template {
    min_replicas = 1
    max_replicas = 2

    container {
      name   = "portal"
      image  = var.portal_image != "" ? var.portal_image : "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  tags = {
    environment = var.environment
    app         = var.app_name
    component   = "portal"
  }
}
