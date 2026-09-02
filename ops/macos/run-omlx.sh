#!/bin/zsh
set -euo pipefail

OMLX_BASE=${OMLX_BASE:-/Users/kei/.omlx}
MODEL_ID=${OMLX_MODEL_ID:-Qwen3.8-Flash-Next-oQ4e-mtp}

if [[ "$(/usr/sbin/sysctl -n iogpu.wired_limit_mb)" != 0 ]]; then
  print -u2 'Refusing to start oMLX with a custom Metal wired-memory limit'
  exit 78
fi

if ! /opt/homebrew/opt/omlx/libexec/bin/python3.11 -c 'import xgrammar' 2>/dev/null; then
  print -u2 'Refusing to start oMLX because xgrammar failed its native import check'
  exit 78
fi

/usr/bin/python3 - "$OMLX_BASE" "$MODEL_ID" <<'PY'
import json
import pathlib
import sys

base = pathlib.Path(sys.argv[1])
model_id = sys.argv[2]
global_settings = json.loads((base / "settings.json").read_text())
model_settings = json.loads((base / "model_settings.json").read_text())["models"][model_id]

checks = {
    "prefill_memory_guard": global_settings["memory"]["prefill_memory_guard"] is True,
    "bounded_memory_tier": global_settings["memory"]["memory_guard_tier"] in {"safe", "aggressive"},
    "bounded_concurrency": global_settings["scheduler"]["max_concurrent_requests"] <= 2,
    "bounded_context": model_settings["max_context_window"] <= 65536,
    "not_pinned": model_settings["is_pinned"] is False,
}
if model_settings["qwen4_ple_ssd_offload"] is False:
    checks.update(
        {
            "resident_aggressive_guard": global_settings["memory"]["memory_guard_tier"] == "aggressive",
            "resident_hard_threshold": global_settings["memory"]["hard_threshold"] <= 0.98,
            "resident_single_request": global_settings["scheduler"]["max_concurrent_requests"] == 1,
            "resident_context": model_settings["max_context_window"] <= 65536,
            "resident_hot_cache_disabled": global_settings["cache"]["hot_cache_max_size"] in {"0", "0B", "0GB"},
        }
    )
failed = [name for name, passed in checks.items() if not passed]
if failed:
    print(f"Refusing unsafe oMLX settings: {', '.join(failed)}", file=sys.stderr)
    raise SystemExit(78)
PY

if ! OMLX_API_KEY="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent.omlx -a kei 2>/dev/null)"; then
  OMLX_API_KEY="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent.omlx -a kei /Library/Keychains/System.keychain)"
fi

export OMLX_API_KEY
exec /opt/homebrew/bin/omlx serve
