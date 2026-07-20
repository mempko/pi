#!/usr/bin/env bash
# Interval validation: does the ECONOMICAL keepalive interval actually hold the
# cache? The efficacy matrix uses 30s pings; the economics section prescribes
# tau* = TTL - margin (~240s for Anthropic/OpenAI). This run validates that a
# 240s keepalive holds prefixes warm through 600s idles (and includes a 30s arm
# for within-run comparison). Run AFTER the main matrix (keepalive traffic must
# not overlap the controlled runs).
#
# Cells: keepalive-only blocks, 3 models x 2 sizes x idles {0,600} x 4 samples
# per interval arm. ~$15-20, ~30 min.
set -euo pipefail

if [[ -z "${CR_UNDER_ENVCONSUL:-}" ]]; then
	export CR_UNDER_ENVCONSUL=1
	exec envconsul -secret=thetaedge/maxlocal -no-prefix -- bash "$0" "$@"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}/../.."

MODELS="${MODELS:-anthropic:claude-sonnet-4-5,openai:gpt-5.1,google:gemini-2.5-pro,openrouter:deepseek/deepseek-v3.2@DeepInfra}"
SAMPLES="${SAMPLES:-4}"
CONCURRENCY="${CONCURRENCY:-6}"
STAGGER="${STAGGER:-1500}"
SUBBATCH="${SUBBATCH:-40}"

for INTERVAL in 240000 30000; do
	TS=$(date +%Y%m%d-%H%M%S)
	OUT="scripts/cache-research/data/v2int${INTERVAL}-${TS}.jsonl"
	echo "===== interval arm ${INTERVAL}ms -> ${OUT} ($(date +%H:%M:%S)) ====="
	node --import tsx scripts/cache-research/collect.ts \
		--models "${MODELS}" \
		--sizes 40000,100000 \
		--idles 0,600 \
		--samples "${SAMPLES}" \
		--keepalive-interval "${INTERVAL}" \
		--concurrency "${CONCURRENCY}" \
		--stagger-ms "${STAGGER}" \
		--subbatch-size "${SUBBATCH}" \
		--block-order keepalive-first \
		--only-block keepalive \
		--run-id "v2int${INTERVAL}-${TS}" \
		--out "${OUT}"
	echo "===== arm ${INTERVAL} done ($(date +%H:%M:%S)) ====="
	sleep 120
done
echo "== interval validation complete =="
