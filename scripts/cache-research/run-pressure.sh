#!/usr/bin/env bash
# Honest load-dependence experiment (the corrected version of v1's Figure 1).
#
# v1 claimed "eviction under load" from data where the harness's own semaphore
# queue delayed probes past the TTL -- an artifact. This experiment instead
# holds the probe schedule fixed (baseline-only cells, staggered, gated) and
# varies the TIER PRESSURE independently: a pressure generator hammers the same
# provider with unique junk prefixes at --pressure-qps during the pressure arm.
#
# Arms alternate in time (pressure / no-pressure) across replicates so a slow
# diurnal tier drift cannot masquerade as a pressure effect. A capacity-driven
# eviction claim is credible only if: same schedule, same gates, and the
# pressured arm's warm rate drops below the unpressured arm's in EVERY replicate.
#
# NOTE: pressure is expensive (unique full prefixes at the given QPS for the
# whole arm). 0.1 qps x 40k tokens x ~14 min arm ~= 3.4M tokens ~= $10 at
# Anthropic write prices, per arm. Budget accordingly.
set -euo pipefail

if [[ -z "${CR_UNDER_ENVCONSUL:-}" ]]; then
	export CR_UNDER_ENVCONSUL=1
	exec envconsul -secret=thetaedge/maxlocal -no-prefix -- bash "$0" "$@"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}/../.."

REPS="${REPS:-3}"
GAP="${GAP:-900}"
SAMPLES="${SAMPLES:-8}"
QPS="${QPS:-0.1}"
PREFIX="${PREFIX:-v2press}"
MODELS="${MODELS:-anthropic:claude-sonnet-4-5}"

echo "== ${REPS} replicates x {no-pressure, pressure=${QPS}qps}, n=${SAMPLES} =="
for i in $(seq 1 "${REPS}"); do
	for ARM in calm pressure; do
		TS=$(date +%Y%m%d-%H%M%S)
		OUT="scripts/cache-research/data/${PREFIX}${i}-${ARM}-${TS}.jsonl"
		PQ=0
		[ "${ARM}" = "pressure" ] && PQ="${QPS}"
		echo ""
		echo "===== rep ${i} arm ${ARM} (qps=${PQ}) -> ${OUT} ($(date +%H:%M:%S)) ====="
		node --import tsx scripts/cache-research/collect.ts \
			--models "${MODELS}" \
			--sizes 40000 \
			--idles 0,60,120,180,300 \
			--samples "${SAMPLES}" \
			--keepalive-interval 30000 \
			--concurrency 6 \
			--stagger-ms 1200 \
			--subbatch-size 40 \
			--block-order baseline-first \
			--only-block baseline \
			--pressure-qps "${PQ}" \
			--run-id "${PREFIX}${i}-${ARM}-${TS}" \
			--out "${OUT}"
		echo "===== rep ${i} arm ${ARM} done ($(date +%H:%M:%S)) ====="
		sleep 60
	done
	if [ "${i}" -lt "${REPS}" ]; then
		echo "sleeping ${GAP}s ..."
		sleep "${GAP}"
	fi
done
echo "== pressure experiment complete =="
