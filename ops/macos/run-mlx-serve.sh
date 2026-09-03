#!/bin/zsh
set -euo pipefail

MODEL_DIR=${MLX_SERVE_MODEL_DIR:-/Users/kei/.mlx-serve/models/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit}
EXPECTED_NGRAM_BYTES=32000153976

if [[ "$(/usr/sbin/sysctl -n iogpu.wired_limit_mb)" != 0 ]]; then
  print -u2 'Refusing to start mlx-serve with a custom Metal wired-memory limit'
  exit 78
fi

for required in config.json model.safetensors.index.json ngram_table.bin tokenizer.json; do
  if [[ ! -r "$MODEL_DIR/$required" ]]; then
    print -u2 "Incomplete mlx-serve model: missing $MODEL_DIR/$required"
    exit 78
  fi
done

if [[ "$(/usr/bin/stat -f %z "$MODEL_DIR/ngram_table.bin")" != "$EXPECTED_NGRAM_BYTES" ]]; then
  print -u2 'Refusing to start with an incomplete Qwen4 n-gram table'
  exit 78
fi

if /usr/bin/find "$MODEL_DIR" -type f -name '*.incomplete' -print -quit | /usr/bin/grep -q .; then
  print -u2 'Refusing to start while Hugging Face downloads are incomplete'
  exit 78
fi

/usr/bin/python3 - "$MODEL_DIR/config.json" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1]))
checks = {
    "qwen4_exp": config.get("model_type") == "qwen4_exp",
    "native_262k": int(config.get("text_config", {}).get("max_position_embeddings", 0)) >= 262_144,
    "mixed_affine": config.get("quantization", {}).get("mode") == "affine",
    "q4_experts": config.get("quantization", {}).get("bits") == 4,
}
failed = [name for name, passed in checks.items() if not passed]
if failed:
    raise SystemExit(f"Refusing incompatible model config: {', '.join(failed)}")
PY

if ! MLX_SERVE_API_KEY="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent.omlx -a kei 2>/dev/null)"; then
  MLX_SERVE_API_KEY="$(/usr/bin/security find-generic-password -w -s ai.nexus.local-agent.omlx -a kei /Library/Keychains/System.keychain)"
fi

export MLX_SERVE_API_KEY
exec /opt/homebrew/bin/mlx-serve \
  --model "$MODEL_DIR" \
  --serve \
  --host 0.0.0.0 \
  --port 8080 \
  --ctx-size 262144 \
  --max-tokens 32768 \
  --timeout 600 \
  --prefill-chunk 2048 \
  --mtp \
  --no-decode-attn-quant \
  --kv-quant off \
  --prefix-cache-entries 64 \
  --prefix-cache-mem 4GB \
  --prefix-cache-disk 100GB \
  --max-resident-models 1 \
  --max-resident-mem 95GB \
  --metrics \
  --api-key-env MLX_SERVE_API_KEY \
  --api-key-strict
