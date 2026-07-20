#!/usr/bin/env bash
# DEPRECATED (2026-07-17): these were the v1 controls. Control A ("self-load
# confound") was itself invalidated: at concurrency 1 the serialized request
# queue delayed probes past the TTL, so its "low-load cliff" was a queueing
# artifact. The honest load-dependence experiment is the pressure-arm design in
# run-pressure.sh. Control B (pinned DeepSeek) is superseded by the v2 harness's
# per-call backend recording and mid-cell backend-change invalidation.
#
# Two controls, run sequentially (B's load must not pollute A).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/lib.sh"
load_secrets
cd "${REPO_ROOT}"
TS=$(date +%Y%m%d-%H%M%S)

echo "===== Control A: self-load test (Anthropic, concurrency 1) ====="
node --import tsx scripts/cache-research/collect.ts \
	--models "anthropic/claude-sonnet-4.5@Amazon Bedrock" \
	--sizes 40000 --idles 300,600 --samples 6 \
	--keepalive-interval 30000 --concurrency 1 \
	--out "scripts/cache-research/data/controlA-lowload-${TS}.jsonl"

echo ""
echo "===== Control B: pinned DeepSeek (DeepInfra) ====="
node --import tsx scripts/cache-research/collect.ts \
	--models "deepseek/deepseek-v3.2@DeepInfra" \
	--sizes 40000,100000 --idles 0,60,300,600 --samples 8 \
	--keepalive-interval 30000 --concurrency 3 \
	--out "scripts/cache-research/data/controlB-deepseek-${TS}.jsonl"

echo ""
echo "== controls complete =="
ls -la scripts/cache-research/data/control*-"${TS}".jsonl
