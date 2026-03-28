#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_SECRET="${WEBHOOK_SECRET:-testsecret}"
LAUNCHER_TOKEN="${LAUNCHER_TOKEN:-testtoken}"
LISTENER_HOST_PORT="${LISTENER_HOST_PORT:-3001}"
DOCKER_GID="${DOCKER_GID:-$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 988)}"
URL="http://localhost:${LISTENER_HOST_PORT}/webhooks/github"
OUTPUT_FILE="./test/output/events.ndjson"
PAYLOAD='{"ref":"refs/heads/main","repository":{"full_name":"my-org/my-repo"},"after":"abc123"}'
DELIVERY_ID="test-delivery-001"
EVENT_NAME="push"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.test.yml"

echo "=== E2E Test: GitHub Webhook Three-Container Chain ==="

trap "echo '--- Cleaning up ---'; docker compose ${COMPOSE_FILES} down -v" EXIT

echo "[1/8] Building runner image..."
docker compose --profile runner build runner

echo "[2/8] Starting stack..."
WEBHOOK_SECRET="$WEBHOOK_SECRET" LAUNCHER_TOKEN="$LAUNCHER_TOKEN" \
  PWD="$(pwd)" LISTENER_HOST_PORT="$LISTENER_HOST_PORT" DOCKER_GID="$DOCKER_GID" \
  docker compose ${COMPOSE_FILES} up -d --build

echo "[3/8] Waiting for listener /healthz..."
TIMEOUT=30
ELAPSED=0
until curl -sf "http://localhost:${LISTENER_HOST_PORT}/healthz" > /dev/null 2>&1; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: listener /healthz did not respond after ${TIMEOUT}s" >&2
    exit 1
  fi
done
echo "    Listener is healthy."

echo "[4/8] Clearing output file..."
mkdir -p ./test/output
: > "$OUTPUT_FILE"

echo "[5/8] Computing HMAC signature..."
SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"
echo "    Signature: ${SIG:0:30}..."

echo "[6/8] Sending webhook POST..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ${EVENT_NAME}" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIG}" \
  -d "$PAYLOAD")

if [ "$HTTP_STATUS" != "202" ]; then
  echo "FAIL: Expected HTTP 202, got ${HTTP_STATUS}" >&2
  exit 1
fi
echo "    Listener responded 202."

echo "[7/8] Waiting for runner to write output file..."
TIMEOUT=30
ELAPSED=0
while [ ! -s "$OUTPUT_FILE" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: ${OUTPUT_FILE} not written after ${TIMEOUT}s" >&2
    echo "--- Stack logs ---" >&2
    docker compose ${COMPOSE_FILES} logs >&2
    exit 1
  fi
done
echo "    Output file written."

echo "[8/8] Asserting output content..."
CONTENT=$(cat "$OUTPUT_FILE")
echo "    Content: $CONTENT"

assert_contains() {
  local label="$1"
  local needle="$2"
  if echo "$CONTENT" | grep -q "$needle"; then
    echo "    PASS: $label"
  else
    echo "    FAIL: $label — expected to find: $needle" >&2
    exit 1
  fi
}

assert_contains "event_name=push"             '"event_name":"push"'
assert_contains "repository=my-org/my-repo"  '"repository":"my-org/my-repo"'
assert_contains "delivery_id=test-delivery-001" '"delivery_id":"test-delivery-001"'

echo ""
echo "=== ALL ASSERTIONS PASSED ==="
