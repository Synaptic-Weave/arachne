#!/usr/bin/env bash
# setup-github-secrets.sh
# Reads CI/CD credentials from Key Vault and sets them as GitHub Actions secrets.
#
# Usage:
#   ./scripts/setup-github-secrets.sh --vault kv-arachne-prod --repo your-org/loom
#
# Prerequisites:
#   - az CLI authenticated (az login)
#   - gh CLI authenticated (gh auth login)
#   - Terraform apply completed (secrets must exist in Key Vault)

set -euo pipefail

VAULT=""
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --repo)  REPO="$2";  shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$VAULT" || -z "$REPO" ]]; then
  echo "Usage: $0 --vault <key-vault-name> --repo <owner/repo>"
  exit 1
fi

echo "Reading CI/CD credentials from Key Vault: $VAULT"

get_secret() {
  az keyvault secret show --vault-name "$VAULT" --name "$1" --query value -o tsv
}

AZURE_CLIENT_ID=$(get_secret "cicd-client-id")
AZURE_CLIENT_SECRET=$(get_secret "cicd-client-secret")
AZURE_TENANT_ID=$(get_secret "cicd-tenant-id")
AZURE_SUBSCRIPTION_ID=$(get_secret "cicd-subscription-id")

echo "Setting GitHub Actions secrets on $REPO ..."

gh secret set AZURE_CLIENT_ID       --body "$AZURE_CLIENT_ID"       --repo "$REPO"
gh secret set AZURE_CLIENT_SECRET   --body "$AZURE_CLIENT_SECRET"   --repo "$REPO"
gh secret set AZURE_TENANT_ID       --body "$AZURE_TENANT_ID"       --repo "$REPO"
gh secret set AZURE_SUBSCRIPTION_ID --body "$AZURE_SUBSCRIPTION_ID" --repo "$REPO"

echo "Done. GitHub Actions secrets set:"
echo "  AZURE_CLIENT_ID"
echo "  AZURE_CLIENT_SECRET"
echo "  AZURE_TENANT_ID"
echo "  AZURE_SUBSCRIPTION_ID"
