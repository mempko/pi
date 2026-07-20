#!/usr/bin/env bash
# Shared helpers for the cache-research scripts. Sourced, not executed.

CR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${CR_DIR}/../.." && pwd)"

# Credentials come from Vault via envconsul (thetaedge/maxlocal exposes
# ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY). Each run script
# re-execs itself under envconsul when CR_UNDER_ENVCONSUL is unset; secret.env
# is only a legacy fallback for the OpenRouter key.
load_secrets() {
	echo "note: load_secrets is deprecated; run scripts re-exec under envconsul" >&2
	if [[ -f "${CR_DIR}/secret.env" ]]; then
		# shellcheck disable=SC1091
		source "${CR_DIR}/secret.env"
	fi
}
