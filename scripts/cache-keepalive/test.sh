#!/usr/bin/env bash
# Run the deterministic cache-keepalive tests (no network, no API key).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "${REPO_ROOT}/packages/agent"
echo "== cache-keepalive unit tests =="
node node_modules/vitest/dist/cli.js --run test/cache-keepalive.test.ts "$@"
