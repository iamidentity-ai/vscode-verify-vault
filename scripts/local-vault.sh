#!/usr/bin/env bash
# Throwaway Vault dev server for testing the broker against another OIDC provider.
#   scripts/local-vault.sh up
#   ISSUER=https://<org>.okta.com/oauth2/default AUD=<client id> BOUND_CLIENT_ID= MOUNT=okta-dev scripts/local-vault.sh setup
#   scripts/local-vault.sh down
# In-memory (dev mode): everything is gone on `down`. Port 8201 because 8200 is used by another container on this laptop.
set -euo pipefail
NAME=vault-dev-broker-test
export VAULT_ADDR="http://127.0.0.1:8201"
export VAULT_TOKEN="root"
case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 127.0.0.1:8201:8200 -e VAULT_DEV_ROOT_TOKEN_ID=root -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 hashicorp/vault:2.0.4 >/dev/null
    for i in $(seq 1 20); do vault status >/dev/null 2>&1 && break; sleep 0.5; done
    vault status | grep -E "Sealed|Version"
    ;;
  setup)
    bash "$(dirname "$0")/vault-setup.sh"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "removed $NAME"
    ;;
  *)
    echo "usage: $0 up|setup|down" >&2; exit 2;;
esac
