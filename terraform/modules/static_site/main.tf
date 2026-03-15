# Azure Static Web App for the dev preview site (arachne-ai.dev)
# Production site (arachne-ai.com) is deployed to GitHub Pages, not Azure.

resource "azurerm_static_web_app" "dev_site" {
  name                = "swa-${var.app_name}-site-${var.environment}"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku_tier = "Free"
  sku_size = "Free"
}

# Store the deploy token in Key Vault for GitHub Actions
resource "azurerm_key_vault_secret" "swa_deploy_token" {
  name         = "swa-deploy-token"
  value        = azurerm_static_web_app.dev_site.api_key
  key_vault_id = var.key_vault_id
}

# ── DNS: arachne-ai.dev (dev preview site → Azure Static Web Apps) ────────

# Custom domain on the Static Web App
resource "azurerm_static_web_app_custom_domain" "dev_site" {
  static_web_app_id = azurerm_static_web_app.dev_site.id
  domain_name       = var.dns_zone_name_dev
  validation_type   = "dns-txt-token"

  # TXT record must exist before custom domain validation
  depends_on = [azurerm_dns_txt_record.dev_site_validation]
}

# Apex A record alias for arachne-ai.dev → Static Web App
resource "azurerm_dns_a_record" "dev_site_apex" {
  name                = "@"
  zone_name           = var.dns_zone_name_dev
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600

  target_resource_id = azurerm_static_web_app.dev_site.id
}

# CNAME for www.arachne-ai.dev → static web app default hostname
resource "azurerm_dns_cname_record" "dev_site_www" {
  name                = "www"
  zone_name           = var.dns_zone_name_dev
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600
  record              = azurerm_static_web_app.dev_site.default_host_name
}

# Apex domain validation TXT record for arachne-ai.dev
resource "azurerm_dns_txt_record" "dev_site_validation" {
  name                = "@"
  zone_name           = var.dns_zone_name_dev
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600

  record {
    value = azurerm_static_web_app.dev_site.default_host_name
  }
}

# ── DNS: arachne-ai.com (production site → GitHub Pages) ──────────────────

# GitHub Pages IPs for apex domain A records
resource "azurerm_dns_a_record" "prod_site_apex" {
  name                = "@"
  zone_name           = var.dns_zone_name_com
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600
  records = [
    "185.199.108.153",
    "185.199.109.153",
    "185.199.110.153",
    "185.199.111.153",
  ]
}

# www CNAME → GitHub Pages
resource "azurerm_dns_cname_record" "prod_site_www" {
  name                = "www"
  zone_name           = var.dns_zone_name_com
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600
  record              = "synaptic-weave.github.io"
}

# GitHub Pages domain verification TXT record
resource "azurerm_dns_txt_record" "prod_site_verification" {
  name                = "_github-pages-challenge-synaptic-weave"
  zone_name           = var.dns_zone_name_com
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600

  record {
    value = "challenge-value-to-be-set"
  }
}

# ── DNS: app.{domain} (portal SPA → Container App) ───────────────────────
# Uses the current workspace's Container App FQDN for the matching domain.

locals {
  dns_zone = var.environment == "prod" ? var.dns_zone_name_com : var.dns_zone_name_dev
}

resource "azurerm_dns_cname_record" "portal_app" {
  name                = "app"
  zone_name           = local.dns_zone
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600
  record              = var.portal_fqdn
}

# ── DNS: api.{domain} (gateway API → Container App) ──────────────────────

resource "azurerm_dns_cname_record" "gateway_api" {
  name                = "api"
  zone_name           = local.dns_zone
  resource_group_name = var.dns_resource_group_name
  ttl                 = 3600
  record              = var.gateway_fqdn
}
