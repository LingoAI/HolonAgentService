#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-fund --no-audit
uv venv --python 3.12 .venv
uv pip sync --python .venv/bin/python requirements.lock
npm run compile
npm run build:wallet
echo 'Ready. Start with: npm run dev:local'
