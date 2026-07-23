#!/usr/bin/env bash
# Retention curve: where does each provider's idle cache actually die?
#
# The published matrix tested idle {0,60,300,600}s, which left two gaps:
#   Phase 0 (left edge): all four providers were fully warm at 300s and only
#     Anthropic was gone by 600s, so the most important boundary in the study
#     sits inside a 5-minute window of ignorance. Bisect it: 360/420/480/540s.
#   Phase 1 (right edge): OpenAI and Google never evicted at 600s, so their
#     keepalive economics were never actually tested (there was nothing to
#     save). Extend to 900/1200/1800/2400s to find their eviction point, if
#     they have one on agent timescales.
#
# Baseline-only (no keepalive): this measures RETENTION, not the strategy.
# The strategy comparison is a follow-up, run only at gaps where eviction is
# demonstrated here. Anthropic is included as a positive control: a run where
# Anthropic fails to evict by 600s is a broken run, not a discovery.
#
# tau stays 240s wherever keepalive arms appear in follow-ups: it is the
# largest interval safely under the shortest documented TTL (300s) and is
# already validated on all four providers.
set -euo pipefail

if [[ -z "${CR_UNDER_ENVCONSUL:-}" ]]; then
	export CR_UNDER_ENVCONSUL=1
	exec envconsul -secret=thetaedge/maxlocal -no-prefix -- bash "$0" "$@"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}/../.."

# The vault no longer carries OPENROUTER_API_KEY (needed only for DeepSeek);
# fall back to the git-ignored local secret.env when it is absent.
if [[ -z "${OPENROUTER_API_KEY:-}" && -f "${DIR}/secret.env" ]]; then
	# shellcheck disable=SC1091
	source "${DIR}/secret.env"
fi

PHASE="${PHASE:-0}"
SAMPLES="${SAMPLES:-6}"
MODELS="${MODELS:-anthropic:claude-sonnet-4-5,openai:gpt-5.1,google:gemini-2.5-pro,openrouter:deepseek/deepseek-v3.2@DeepInfra}"

# Sub-batch size and concurrency must be chosen together. A batch takes as long
# as its LONGEST idle, so small batches multiply wall-clock by the batch count
# (Phase 1's 2400s cells at 12-cell batches would take ~7h). But a big batch
# means its reqB calls all come due at nearly the same instant, and if the HTTP
# semaphore cannot drain that wave in under the queue-wait gate (5s), every cell
# in the batch is invalidated. A first attempt at subbatch=60/concurrency=2 lost
# 9 of 9 cells to ~18s queue waits.
#
# Rule: concurrency >= subbatch / (gate_seconds / call_seconds). At ~8s per 100k
# call and a 5s gate, a 30-cell wave needs roughly 30 slots to clear in time, so
# match concurrency to the batch and let the stagger spread reqA.
if [[ "${PHASE}" == "0" ]]; then
	IDLES="${IDLES:-0,360,420,480,540}"
	PREFIX="${PREFIX:-v2curve0}"
	SUBBATCH="${SUBBATCH:-30}"
	STAGGER="${STAGGER:-4000}"
	CONCURRENCY="${CONCURRENCY:-8}"
else
	IDLES="${IDLES:-0,900,1200,1800,2400}"
	PREFIX="${PREFIX:-v2curve1}"
	SUBBATCH="${SUBBATCH:-30}"
	STAGGER="${STAGGER:-4000}"
	CONCURRENCY="${CONCURRENCY:-8}"
fi

TS=$(date +%Y%m%d-%H%M%S)
OUT="scripts/cache-research/data/${PREFIX}-${TS}.jsonl"

echo "== retention curve phase ${PHASE}: idles=${IDLES} n=${SAMPLES} =="
echo "== models: ${MODELS} =="

# Baseline-only: --only-block baseline drops the keepalive block entirely.
# Concurrency 2 with a long stagger keeps Gemini under its 1K requests/day cap
# (each cell is 2 calls here, so the whole phase is well under 200 requests).
node --import tsx scripts/cache-research/collect.ts \
	--models "${MODELS}" \
	--sizes 100000 \
	--idles "${IDLES}" \
	--samples "${SAMPLES}" \
	--keepalive-interval 240000 \
	--concurrency "${CONCURRENCY}" \
	--stagger-ms "${STAGGER}" \
	--subbatch-size "${SUBBATCH}" \
	--block-order baseline-first \
	--only-block baseline \
	--retry-attempts 2 \
	--run-id "${PREFIX}-${TS}" \
	--out "${OUT}"

echo ""
echo "== phase ${PHASE} complete: ${OUT} =="
