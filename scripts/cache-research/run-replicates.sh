#!/usr/bin/env bash
# Three INDEPENDENT replicate runs of the v2 3-provider matrix, separated in time.
#
# Why separated runs: samples within a run share one moment's cache-tier
# conditions (pseudo-replication). The run, not the sample, is the unit of
# statistical independence; a claim must hold in every run.
#
# Block order alternates across replicates (baseline-first / keepalive-first)
# so time-of-day and order effects don't confound the condition comparison.
# Conditions are time-blocked within a run so keepalive traffic cannot pressure
# the tier during baseline measurements (the v1 interference defect).
#
# Env overrides: REPS (3), GAP seconds between runs (1800), SAMPLES (8).
# Real, paid requests: roughly $70-90 per replicate at the default 3x8 design,
# including keepalive pings (which v1 did not count). ~1.5h wall per replicate.
set -euo pipefail

# Keys come from Vault via envconsul (same pattern as ironguard-web's data_tools.sh).
if [[ -z "${CR_UNDER_ENVCONSUL:-}" ]]; then
	export CR_UNDER_ENVCONSUL=1
	exec envconsul -secret=thetaedge/maxlocal -no-prefix -- bash "$0" "$@"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}/../.."

REPS="${REPS:-3}"
GAP="${GAP:-1800}"
SAMPLES="${SAMPLES:-8}"
CONCURRENCY="${CONCURRENCY:-6}"
STAGGER="${STAGGER:-1200}"
SUBBATCH="${SUBBATCH:-56}"
RETRY="${RETRY:-6}"
PREFIX="${PREFIX:-v2rep}"
MODELS="${MODELS:-anthropic:claude-sonnet-4-5,openai:gpt-5.1,google:gemini-2.5-pro,openrouter:deepseek/deepseek-v3.2@DeepInfra}"

echo "== ${REPS} replicates, n=${SAMPLES}, ${GAP}s apart, concurrency ${CONCURRENCY} =="
echo "== models: ${MODELS} =="
for i in $(seq 1 "${REPS}"); do
	# Alternate condition-block order across replicates.
	if [ $((i % 2)) -eq 1 ]; then ORDER="baseline-first"; else ORDER="keepalive-first"; fi
	TS=$(date +%Y%m%d-%H%M%S)
	OUT="scripts/cache-research/data/${PREFIX}${i}-${TS}.jsonl"
	echo ""
	echo "===== replicate ${i}/${REPS} (${ORDER}) -> ${OUT} ($(date +%H:%M:%S)) ====="
	node --import tsx scripts/cache-research/collect.ts \
		--models "${MODELS}" \
		--sizes 40000,100000 \
		--idles 0,60,300,600 \
		--samples "${SAMPLES}" \
		--keepalive-interval 30000 \
		--concurrency "${CONCURRENCY}" \
		--stagger-ms "${STAGGER}" \
		--subbatch-size "${SUBBATCH}" \
		--block-order "${ORDER}" \
		--retry-attempts "${RETRY}" \
		--run-id "${PREFIX}${i}-${TS}" \
		--out "${OUT}"
	echo "===== replicate ${i} done ($(date +%H:%M:%S)) ====="
	if [ "${i}" -lt "${REPS}" ]; then
		echo "sleeping ${GAP}s for temporal separation ..."
		sleep "${GAP}"
	fi
done
echo ""
echo "== all ${REPS} replicates complete =="
ls -la scripts/cache-research/data/"${PREFIX}"*.jsonl
