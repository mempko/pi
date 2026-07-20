#!/usr/bin/env bash
# Quick real-provider profile: short idle, all three configs. ~1 minute, low cost.
# Validates the end-to-end path and shows the cache-read/TTFT columns.
# Any extra args are forwarded to the profiler.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
load_api_key

cd "${REPO_ROOT}"
echo "== quick profile (idle 5s, warm cache expected everywhere) =="
node --import tsx scripts/profile-session.ts \
	--provider anthropic --model claude-sonnet-4-5 \
	--idle 5 --configs baseline,long,keepalive \
	--prefix-tokens 4000 --runs 1 "$@"
