#!/bin/zsh
set -euo pipefail

# Local Nexus runs can include planning, remote execution, patch integration,
# and independent verification. Keep OMP from abandoning the MCP response while
# that work is still active on the fabric.
export OMP_MCP_TIMEOUT_MS="${OMP_MCP_TIMEOUT_MS:-900000}"

exec /opt/homebrew/bin/omp \
  --profile qwen-local \
  --approval-mode yolo \
  --thinking low \
  --no-skills \
  --no-rules \
  --system-prompt /Users/kei/.omp/qwen-system.md \
  "$@"
