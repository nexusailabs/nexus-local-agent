#!/bin/zsh
set -euo pipefail

NEXUS_ROOT=/Users/kei/projects/nexus-local-agent
NEXUS_STATE_ROOT='/Users/kei/Library/Application Support/Nexus/state'

export NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei)"
export NEXUS_BIND=0.0.0.0
export NEXUS_CONTROL_PORT=7788
export NEXUS_STATE_DIR="$NEXUS_STATE_ROOT"
export NEXUS_CONFIG="$NEXUS_ROOT/config/cluster.yaml"

mkdir -p "$NEXUS_STATE_ROOT"
exec /opt/homebrew/bin/pnpm --dir "$NEXUS_ROOT" dev:control
