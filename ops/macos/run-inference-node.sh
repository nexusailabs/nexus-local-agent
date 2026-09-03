#!/bin/zsh
set -euo pipefail

NEXUS_ROOT=/Users/kei/projects/nexus-local-agent
NEXUS_MACHINE_CONFIG=/Users/kei/.config/nexus-local-agent/inference.env

if [[ ! -r "$NEXUS_MACHINE_CONFIG" ]]; then
  print -u2 "Missing machine config: $NEXUS_MACHINE_CONFIG"
  exit 78
fi
source "$NEXUS_MACHINE_CONFIG"
: "${NEXUS_CONTROL_URL:?missing NEXUS_CONTROL_URL}"
: "${NEXUS_NODE_BASE_URL:?missing NEXUS_NODE_BASE_URL}"
: "${NEXUS_MODEL_BASE_URL:?missing NEXUS_MODEL_BASE_URL}"
: "${NEXUS_MODEL_ID:?missing NEXUS_MODEL_ID}"
: "${NEXUS_MODEL_PROVIDER:?missing NEXUS_MODEL_PROVIDER}"
: "${NEXUS_MODEL_CONTEXT_WINDOW:?missing NEXUS_MODEL_CONTEXT_WINDOW}"
: "${NEXUS_MODEL_MAX_OUTPUT_TOKENS:?missing NEXUS_MODEL_MAX_OUTPUT_TOKENS}"
export NEXUS_CONTROL_URL NEXUS_NODE_BASE_URL NEXUS_MODEL_BASE_URL
export NEXUS_MODEL_ID NEXUS_MODEL_PROVIDER NEXUS_MODEL_CONTEXT_WINDOW
export NEXUS_MODEL_MAX_OUTPUT_TOKENS
if [[ -n "${NEXUS_CONTROL_ROUTES_JSON:-}" ]]; then
  export NEXUS_CONTROL_ROUTES_JSON
fi

if ! NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei 2>/dev/null)"; then
  NEXUS_SHARED_TOKEN="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent -a kei /Library/Keychains/System.keychain)"
fi
if ! NEXUS_MODEL_API_KEY="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent.omlx -a kei 2>/dev/null)"; then
  NEXUS_MODEL_API_KEY="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent.omlx -a kei /Library/Keychains/System.keychain)"
fi

export NEXUS_SHARED_TOKEN NEXUS_MODEL_API_KEY
export NEXUS_NODE_ID=mbp-m5-max
export NEXUS_BIND=0.0.0.0
export NEXUS_NODE_PORT=7790
export NEXUS_NODE_CAPABILITIES=inference,exec,fs,git,code,documents,long-running
export NEXUS_NODE_REACHABILITY=lan
export NEXUS_NODE_TAGS=apple-silicon,m5-max,metal,mlx,tailscale
export NEXUS_EXECUTION_CLASS=70
export NEXUS_RELIABILITY_CLASS=95
export NEXUS_HEARTBEAT_MS=10000
export NEXUS_MODELS_JSON="$(/usr/bin/python3 -c '
import json, os
print(json.dumps([{
    "id": os.environ["NEXUS_MODEL_ID"],
    "provider": os.environ["NEXUS_MODEL_PROVIDER"],
    "baseUrl": os.environ["NEXUS_MODEL_BASE_URL"],
    "apiKey": os.environ["NEXUS_MODEL_API_KEY"],
    "contextWindow": int(os.environ["NEXUS_MODEL_CONTEXT_WINDOW"]),
    "maxOutputTokens": int(os.environ["NEXUS_MODEL_MAX_OUTPUT_TOKENS"]),
    "capabilities": ["reasoning", "coding", "tool-use", "long-context", "review", "vision"],
    "costClass": 70,
    "speedClass": 94,
    "qualityClass": 98,
}]))
')"

model_ready=false
for _ in {1..60}; do
  if /usr/bin/curl -fsS --connect-timeout 2 \
    -H "Authorization: Bearer $NEXUS_MODEL_API_KEY" \
    http://127.0.0.1:8080/v1/models \
    | /usr/bin/python3 -c '
import json, sys
payload = json.load(sys.stdin)
ids = {model.get("id") for model in payload.get("data", [])}
raise SystemExit(0 if ids else 1)
'; then
    model_ready=true
    break
  fi
  /bin/sleep 5
done

if [[ "$model_ready" != true ]]; then
  print -u2 'model server did not become ready within 5 minutes'
  exit 75
fi

exec /opt/homebrew/bin/pnpm --dir "$NEXUS_ROOT" dev:node
