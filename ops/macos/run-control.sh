#!/bin/zsh
set -euo pipefail

NEXUS_ROOT=/Users/kei/projects/nexus-local-agent
NEXUS_STATE_ROOT='/Users/kei/Library/Application Support/Nexus/state'
NEXUS_MACHINE_CONFIG=/Users/kei/.config/nexus-local-agent/control.env

if [[ ! -r "$NEXUS_MACHINE_CONFIG" ]]; then
  print -u2 "Missing machine config: $NEXUS_MACHINE_CONFIG"
  exit 78
fi
source "$NEXUS_MACHINE_CONFIG"
: "${NEXUS_CONTROL_TAILSCALE_IP:?missing NEXUS_CONTROL_TAILSCALE_IP}"

local_tail_ip="$(/opt/homebrew/bin/tailscale ip -4 | /usr/bin/head -n 1)"
if [[ "$local_tail_ip" != "$NEXUS_CONTROL_TAILSCALE_IP" ]]; then
  print -u2 "Refusing to start control plane on non-canonical host: $local_tail_ip"
  exit 78
fi

if ! NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei 2>/dev/null)"; then
  NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei /Library/Keychains/System.keychain)"
fi
export NEXUS_SHARED_TOKEN
export NEXUS_BIND=0.0.0.0
export NEXUS_CONTROL_PORT=7788
export NEXUS_STATE_DIR="$NEXUS_STATE_ROOT"
export NEXUS_CONFIG="$NEXUS_ROOT/config/cluster.yaml"

mkdir -p "$NEXUS_STATE_ROOT"
exec /opt/homebrew/bin/pnpm --dir "$NEXUS_ROOT" dev:control
