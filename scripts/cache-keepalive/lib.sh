#!/usr/bin/env bash
# Shared helpers for the cache-keepalive scripts. Sourced, not executed.

# Resolve the repo root from this file's location (scripts/cache-keepalive/lib.sh).
CK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${CK_DIR}/../.." && pwd)"

# Load ANTHROPIC_API_KEY: prefer an already-exported env var, otherwise source
# the git-ignored secret.env next to this script.
load_api_key() {
	if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
		return 0
	fi
	if [[ -f "${CK_DIR}/secret.env" ]]; then
		# shellcheck disable=SC1091
		source "${CK_DIR}/secret.env"
	fi
	if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
		echo "error: ANTHROPIC_API_KEY is not set." >&2
		echo "  Either 'export ANTHROPIC_API_KEY=...' or put it in ${CK_DIR}/secret.env" >&2
		return 1
	fi
}
