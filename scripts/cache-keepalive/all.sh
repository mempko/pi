#!/usr/bin/env bash
# Run the deterministic tests, then the quick real-provider profile.
# For the slow TTL-crossing comparison run ./profile-ttl.sh instead.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${DIR}/test.sh"
"${DIR}/profile-quick.sh" "$@"
