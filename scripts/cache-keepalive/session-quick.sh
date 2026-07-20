#!/usr/bin/env bash
# Fast end-to-end multi-turn session with a REAL bash tool. 5 rounds of
# prompt -> bash wait (20s) -> reply, with keepalive pings firing during each
# wait (interval 5s). Short waits stay under the TTL, so this proves the
# real multi-turn loop + pings, not eviction. Extra args forward to the profiler.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${DIR}/lib.sh"
load_api_key

cd "${REPO_ROOT}"
# The script imports workspace packages by name; point tsx at the tsconfig that
# maps them to source.
export TSX_TSCONFIG_PATH="${REPO_ROOT}/tsconfig.json"
node --import tsx scripts/profile-agent-session.ts \
	--model claude-sonnet-4-5 --turns 5 --wait 20 --keepalive-interval 5000 \
	--configs baseline,keepalive --prefix-tokens 6000 "$@"
