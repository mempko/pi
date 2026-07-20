#!/usr/bin/env bash
# End-to-end multi-turn session where each tool call crosses the TTL. 2 rounds of
# prompt -> bash wait (330s, past Anthropic's ~5-min TTL) -> reply, comparing
# baseline / long / keepalive. On each round's resume request, expect baseline
# (and possibly long) cacheRead to collapse while keepalive holds it.
# SLOW (~2 rounds x 330s x 3 configs ~= 33 min) and makes paid requests.
# Extra args forward to the profiler.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/lib.sh"
load_api_key

cd "${REPO_ROOT}"
export TSX_TSCONFIG_PATH="${REPO_ROOT}/tsconfig.json"
echo "== agent-session TTL test (2 rounds x 330s bash wait x 3 configs, ~33 min) =="
node --import tsx scripts/profile-agent-session.ts \
	--model claude-sonnet-4-5 --turns 2 --wait 330 --keepalive-interval 60000 \
	--configs baseline,long,keepalive --prefix-tokens 6000 "$@"
