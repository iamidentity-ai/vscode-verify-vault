#!/usr/bin/env bash
# Configure a Vault jwt auth mount that trusts one OIDC issuer for developer sign-in.
#   VAULT_ADDR=... VAULT_TOKEN=... ISSUER=... [MOUNT=verify-dev] [AUD=vault-dev-broker] [BOUND_CLIENT_ID=...] [USER_CLAIM=sub] bash vault-setup.sh
# Idempotent. Adds only: auth/$MOUNT (jwt), policy dev-secrets, role developer, secret/dev/shared/demo.
# Bring your own tenant: ISSUER is required, no default. BOUND_CLIENT_ID defaults to empty (no client_id
# binding); set it to pin the role to one app's client_id (IBM Verify issues that claim).
# The role write MERGES into the stored role, so omitting bound_claims on a re-run would leave a stale
# binding in place; BOUND_CLIENT_ID="" sends an explicit empty bound_claims to clear it.
set -euo pipefail
: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_TOKEN:?VAULT_TOKEN is required}"
: "${ISSUER:?ISSUER is required, for example https://<tenant>/oauth2 for IBM Verify}"
MOUNT="${MOUNT:-verify-dev}"
AUD="${AUD:-vault-dev-broker}"
BOUND_CLIENT_ID="${BOUND_CLIENT_ID-}"
USER_CLAIM="${USER_CLAIM:-sub}"

vault read "sys/auth/$MOUNT" >/dev/null 2>&1 || vault auth enable -path="$MOUNT" -description="Developer sign-in via $ISSUER" jwt
# Discovery instead of a hardcoded JWKS URL: Verify, Okta, Entra, Auth0 and Keycloak all publish it.
vault write "auth/$MOUNT/config" oidc_discovery_url="$ISSUER" bound_issuer="$ISSUER" default_role=developer

ACC=$(vault read -field=accessor "sys/auth/$MOUNT")

vault policy write dev-secrets - <<EOF
# Shared dev secrets: read-only for every signed-in developer.
path "secret/data/dev/shared/*"     { capabilities = ["read"] }
path "secret/metadata/dev/shared/*" { capabilities = ["list", "read"] }
# Personal path keyed on the user id (entity alias name on this mount).
path "secret/data/dev/users/{{identity.entity.aliases.$ACC.name}}/*"     { capabilities = ["create", "update", "read"] }
path "secret/metadata/dev/users/{{identity.entity.aliases.$ACC.name}}/*" { capabilities = ["list", "read", "delete"] }
# No lease-revoke grant: nothing under this policy can mint a dynamic lease yet. Add a narrow
# revoke-prefix grant on the specific mount when a dynamic engine is granted (agent-identity plan).
EOF

# 30 minute Vault tokens and an optional client_id binding: Vault does not consult the provider for
# revocation, so keep the window short and, where the token carries client_id (IBM Verify), pin the app.
# bound_claims is a map field; this Vault's CLI only accepts it via a full JSON body on stdin.
if [ -n "$BOUND_CLIENT_ID" ]; then
  BOUND_JSON=", \"bound_claims_type\": \"string\", \"bound_claims\": {\"client_id\": \"$BOUND_CLIENT_ID\"}"
else
  BOUND_JSON=', "bound_claims_type": "string", "bound_claims": {}'
fi
vault write "auth/$MOUNT/role/developer" - <<JSON
{
  "role_type": "jwt",
  "user_claim": "$USER_CLAIM",
  "bound_audiences": "$AUD",
  "token_policies": "dev-secrets",
  "token_ttl": "30m",
  "token_max_ttl": "1h"$BOUND_JSON
}
JSON

vault kv get -field=value secret/dev/shared/demo >/dev/null 2>&1 || \
  vault kv put secret/dev/shared/demo value="demo-$(date +%s)-never-print-me"

echo "ok: mount $MOUNT (accessor $ACC), issuer $ISSUER, policy dev-secrets, role developer (aud $AUD, bound client_id '${BOUND_CLIENT_ID}'), secret/dev/shared/demo seeded"
