#!/bin/zsh
set -euo pipefail

NEXUS_ROOT=/Users/kei/projects/nexus-local-agent

if ! NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei 2>/dev/null)"; then
  NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei /Library/Keychains/System.keychain)"
fi

export NEXUS_SHARED_TOKEN
export NEXUS_CONTROL_URL="${NEXUS_CONTROL_URL:-http://127.0.0.1:7788}"
export NEXUS_DEFAULT_NODE_ID="${NEXUS_DEFAULT_NODE_ID:-mbp-m5-max}"
export NEXUS_NODE_ROUTES_JSON="${NEXUS_NODE_ROUTES_JSON:-{\"mbp-m5-max\":[\"http://169.254.77.1:7790\",\"http://100.107.237.37:7790\"]}}"

exec /opt/homebrew/bin/node "$NEXUS_ROOT/apps/mcp-adapter/dist/index.js"
