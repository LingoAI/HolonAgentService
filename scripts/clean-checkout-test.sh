#!/usr/bin/env bash
# Test a committed checkout with a fresh Docker build and no private keys/data.
# Usage: scripts/clean-checkout-test.sh [git-url-or-local-repo] [port]
set -euo pipefail
REPO=${1:-git@github-lingo:LingoAI/HolonAgentService.git}
APP_PORT=${2:-8791}
CHECK_DIR=$(mktemp -d /tmp/okx-clean-XXXXXX)
CHECK_NAME="okx-clean-$$"
cleanup() { docker rm -f "$CHECK_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git clone --no-hardlinks --depth 1 "$REPO" "$CHECK_DIR/app"
cd "$CHECK_DIR/app"
docker build -t "$CHECK_NAME" .
docker run -d --name "$CHECK_NAME" -p "127.0.0.1:$APP_PORT:8765" "$CHECK_NAME" >/dev/null
for ((i=0;i<90;i++)); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/health" >"$CHECK_DIR/health.json" 2>/dev/null; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$APP_PORT/api/xlayer/config" >"$CHECK_DIR/config.json"
python3 - "$CHECK_DIR/config.json" <<'CHECK'
import json, sys
from pathlib import Path
config = json.load(open(sys.argv[1]))
assert config["network"]["chainId"] == 1952
manifest = Path('contracts/deployments/xlayer-testnet.json')
assert config["configured"] is manifest.exists()
if manifest.exists():
    assert config["deployment"] == json.loads(manifest.read_text())
CHECK
curl -fsS "http://127.0.0.1:$APP_PORT/vendor/x402-wallet.js" -o /dev/null
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$APP_PORT/api/xlayer/local-action")
[[ "$STATUS" == 403 ]]
echo "CLEAN-CHECKOUT: PASS ($CHECK_DIR)"
