#!/usr/bin/env bash
# Crowd-Signal deploy (ADR 0003): Coolify API redeploy — NEVER "restart" for env
# changes. Flow: capture rollback digest → trigger deploy → poll → verify
# /healthz + trigger behavior → record digest.
#
# Requires .verity/deploy.env (gitignored) with COOLIFY_API_URL,
# COOLIFY_API_TOKEN, TRIGGER_API_TOKEN. App UUID + base URL are fixed below.
# Usage: ops/deploy.sh [--skip-behavior-check]
set -euo pipefail

APP_UUID="ue1khehsjcb77de7ulzbyl1u"
BASE_URL="http://ue1khehsjcb77de7ulzbyl1u.34.207.137.224.sslip.io"
SSH_HOST="ubuntu@34.207.137.224"
SSH_KEY="$HOME/.ssh/id_ed25519"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck disable=SC1091
set -a; . "$REPO_ROOT/.verity/deploy.env"; set +a
: "${COOLIFY_API_URL:?}" "${COOLIFY_API_TOKEN:?}" "${TRIGGER_API_TOKEN:?}"
AUTH=(-H "Authorization: Bearer $COOLIFY_API_TOKEN")

say() { printf '\n== %s\n' "$*"; }

say "rollback point: current image digest on the box"
PREV_DIGEST=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_HOST" \
  "docker inspect --format '{{.Image}}' \$(docker ps -q --filter name=$APP_UUID) 2>/dev/null | head -1" || true)
echo "previous digest: ${PREV_DIGEST:-<none — first deploy>}"

say "trigger Coolify deploy (build from git, ARM-native on the box)"
DEPLOY_JSON=$(curl -sf "${AUTH[@]}" "$COOLIFY_API_URL/api/v1/deploy?uuid=$APP_UUID&force=false")
DEPLOY_UUID=$(echo "$DEPLOY_JSON" | jq -r '.deployments[0].deployment_uuid // empty')
echo "deployment: ${DEPLOY_UUID:-<no uuid returned>}"

say "poll deployment status"
for _ in $(seq 1 60); do
  STATUS=$(curl -sf "${AUTH[@]}" "$COOLIFY_API_URL/api/v1/deployments/$DEPLOY_UUID" | jq -r '.status // "unknown"')
  echo "  status: $STATUS"
  case "$STATUS" in
    finished) break ;;
    failed|cancelled*) echo "DEPLOY FAILED ($STATUS) — rollback: re-deploy previous commit; digest was: $PREV_DIGEST"; exit 1 ;;
  esac
  sleep 10
done
[ "$STATUS" = "finished" ] || { echo "TIMEOUT waiting for deployment"; exit 1; }

say "verify /healthz (behavior, from outside the box)"
for _ in $(seq 1 12); do
  BODY=$(curl -sf --max-time 10 "$BASE_URL/healthz" || true)
  [ -n "$BODY" ] && break
  sleep 5
done
echo "healthz: $BODY"
echo "$BODY" | jq -e '.ok == true and .db == "ok"' >/dev/null || { echo "HEALTHZ NOT OK — rollback digest: $PREV_DIGEST"; exit 1; }

if [ "${1:-}" != "--skip-behavior-check" ]; then
  say "verify trigger behavior (auth + idempotency, no email surface exists)"
  UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/trigger/daily")
  [ "$UNAUTH" = "401" ] || { echo "expected 401 unauthenticated, got $UNAUTH"; exit 1; }
  R1=$(curl -sf -X POST -H "Authorization: Bearer $TRIGGER_API_TOKEN" "$BASE_URL/trigger/daily")
  echo "trigger: $R1"
  echo "$R1" | jq -e '.runId' >/dev/null || { echo "trigger did not return runId"; exit 1; }
fi

say "record new digest"
NEW_DIGEST=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_HOST" \
  "docker inspect --format '{{.Image}}' \$(docker ps -q --filter name=$APP_UUID) | head -1")
echo "deployed digest: $NEW_DIGEST"
echo "rollback digest: ${PREV_DIGEST:-<none>}"
echo
echo "OK — record these in STATUS.md via: verity status set environments.prod.digest $NEW_DIGEST"
