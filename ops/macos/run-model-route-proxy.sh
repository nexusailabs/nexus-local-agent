#!/bin/zsh
set -euo pipefail

export NEXUS_MODEL_TB4_URL="${NEXUS_MODEL_TB4_URL:-http://169.254.77.1:8080}"
export NEXUS_MODEL_TAILSCALE_URL="${NEXUS_MODEL_TAILSCALE_URL:-http://100.107.237.37:8080}"
export NEXUS_MODEL_PROXY_HOST="${NEXUS_MODEL_PROXY_HOST:-127.0.0.1}"
export NEXUS_MODEL_PROXY_PORT="${NEXUS_MODEL_PROXY_PORT:-18081}"

exec /opt/homebrew/bin/node /Users/kei/projects/nexus-local-agent/ops/macos/model-route-proxy.mjs
