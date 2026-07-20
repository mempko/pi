#!/usr/bin/env bash
# Cheap end-to-end smoke test of the v2 harness (~$5, ~15 min).
# Validates: transports, timing gates (queue wait ~= 0, idle slip small),
# warm-reference gate, ping recording, cost accounting incl. pings.
set -euo pipefail

# Keys come from Vault via envconsul (same pattern as ironguard-web's data_tools.sh).
if [[ -z "${CR_UNDER_ENVCONSUL:-}" ]]; then
	export CR_UNDER_ENVCONSUL=1
	exec envconsul -secret=thetaedge/maxlocal -no-prefix -- bash "$0" "$@"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}/../.."

TS=$(date +%Y%m%d-%H%M%S)
OUT="scripts/cache-research/data/pilot2-${TS}.jsonl"

node --import tsx scripts/cache-research/collect.ts \
	--models "anthropic:claude-sonnet-4-5,openai:gpt-5.1,openrouter:deepseek/deepseek-v3.2@DeepInfra" \
	--sizes 40000 \
	--idles 0,60,300 \
	--samples 2 \
	--keepalive-interval 30000 \
	--concurrency 6 \
	--stagger-ms 1000 \
	--subbatch-size 24 \
	--block-order baseline-first \
	--run-id "pilot2-${TS}" \
	--out "${OUT}"

echo ""
echo "== pilot complete: ${OUT} =="
