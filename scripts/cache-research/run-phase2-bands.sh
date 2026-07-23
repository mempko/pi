#!/usr/bin/env bash
# Phase 2: does the keepalive save money OUTSIDE Anthropic, inside each
# provider's measured paying band?
#
# Phase 0/1 located each provider's eviction point and the retention curve.
# The paying band is (eviction point, I_max), where I_max = tau*(w/r - 1) at
# tau=240s:
#   Anthropic: 360s .. 46min   (control: already shown to save at 600s)
#   DeepSeek:  600s .. 36min
#   OpenAI:    ~1500s .. 35min  (evicts by 1800s; never tested before)
#
# 1800s (30 min) sits inside all three bands, and at 1800s every one of these
# providers is fully evicted at baseline (measured 0/6), so there is a real
# re-prefill to avoid. This is the experiment the paper could not run: it tests
# the hypothesis that every evicting provider pays inside its band, not just
# Anthropic. Google is excluded: its cache never converges to cold (a machine
# lottery, not a retention curve), so it has no band and no re-prefill to insure.
#
# Both blocks (baseline + keepalive), tau=240s held fixed. subbatch/concurrency
# sized per the Phase 1 lesson: a big reqB wave that cannot drain under the 5s
# queue-wait gate invalidates the whole batch, so concurrency covers the batch.
set -euo pipefail

if [[ -z "${CR_UNDER_ENVCONSUL:-}" ]]; then
	export CR_UNDER_ENVCONSUL=1
	exec envconsul -secret=thetaedge/maxlocal -no-prefix -- bash "$0" "$@"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}/../.."
if [[ -z "${OPENROUTER_API_KEY:-}" && -f "${DIR}/secret.env" ]]; then
	# shellcheck disable=SC1091
	source "${DIR}/secret.env"
fi

MODELS="${MODELS:-anthropic:claude-sonnet-4-5,openai:gpt-5.1,openrouter:deepseek/deepseek-v3.2@DeepInfra}"
SAMPLES="${SAMPLES:-8}"
IDLES="${IDLES:-0,1800}"
TS=$(date +%Y%m%d-%H%M%S)
OUT="scripts/cache-research/data/v2band-${TS}.jsonl"

echo "== Phase 2 (paying bands): idles=${IDLES} tau=240s n=${SAMPLES} =="
echo "== models: ${MODELS} =="

node --import tsx scripts/cache-research/collect.ts \
	--models "${MODELS}" \
	--sizes 100000 \
	--idles "${IDLES}" \
	--samples "${SAMPLES}" \
	--keepalive-interval 240000 \
	--concurrency 8 \
	--stagger-ms 4000 \
	--subbatch-size 24 \
	--block-order baseline-first \
	--retry-attempts 3 \
	--run-id "v2band-${TS}" \
	--out "${OUT}"

echo ""
echo "== Phase 2 complete: ${OUT} =="
