#!/usr/bin/env bash
# Final analysis pipeline for the v2 cache-research runs.
# Usage: bash scripts/cache-research/analyze-all.sh
#
# Inputs (globbed): v2rep1-partial + v2full1/2 + v2goog1 matrix files, and
# v2int* interval-validation files. Every provider gets three runs:
#   anthropic/openai/deepseek: v2rep1-partial, v2full1, v2full2
#   google:                    v2full1, v2full2, v2goog1
# Emits: stats report (stdout + paper/data/stats.json), regenerated paper/data
# tables and macros, the strategy-cost table, and a rebuilt paper PDF.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

MATRIX=$(ls scripts/cache-research/data/v2full1-*.jsonl scripts/cache-research/data/v2full2-*.jsonl scripts/cache-research/data/v2rep1-*.jsonl scripts/cache-research/data/v2goog1-*.jsonl 2>/dev/null)
INTERVALS=$(ls scripts/cache-research/data/v2int*.jsonl 2>/dev/null || true)

echo "== stats (Fisher primary, replication across runs) =="
# shellcheck disable=SC2086
python3 scripts/cache-research/stats.py ${MATRIX} --json paper/data/stats.json

echo ""
echo "== aggregate tables + macros =="
# shellcheck disable=SC2086
cat ${MATRIX} > /tmp/v2agg.jsonl
node --import tsx scripts/cache-research/analyze.ts --in /tmp/v2agg.jsonl --outdir paper/data

echo ""
echo "== strategy-cost table =="
# shellcheck disable=SC2086
python3 scripts/cache-research/cost_table.py --matrix ${MATRIX} --intervals ${INTERVALS} --out paper/data/cost-table.tex

echo ""
echo "== rebuild paper =="
bash paper/build.sh
