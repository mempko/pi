#!/usr/bin/env bash
# TTL-crossing profile: compares a short idle against one that exceeds Anthropic's
# ~5-minute default cache TTL. Expect baseline's cacheRead to collapse at idle=330
# while `long` and `keepalive` hold it. This is SLOW (~18 min: it really sleeps)
# and makes several paid requests. Extra args are forwarded to the profiler.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
load_api_key

cd "${REPO_ROOT}"
echo "== TTL-crossing profile (idle 5s vs 330s; keepalive pings every 60s) =="
echo "   this sleeps through the idle durations and will take ~18 minutes"
node --import tsx scripts/profile-session.ts \
	--provider anthropic --model claude-sonnet-4-5 \
	--idle 5,330 --configs baseline,long,keepalive \
	--keepalive-interval 60000 --prefix-tokens 4000 --runs 1 "$@"
