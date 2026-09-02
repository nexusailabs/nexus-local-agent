# MBP M5 Max inference node

## Deployed profile

- Runtime: mlx-serve 26.8.11, MLX 0.32.2.
- Model: `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`.
- Model revision: `ef5b919d31534faa1997666f1a22d362cd6383cd`.
- Model directory:
  `~/.mlx-serve/models/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`.
- Quality policy: routed experts use affine 4-bit group 64, while attention,
  GDN, hyper-connections, indexer, shared experts, LM head and the matching MTP
  head use 8-bit group 64. Embeddings use 4-bit group 64. The 51B-parameter
  PLE table uses 4-bit group 32 in the publisher's exact 32 GB mmap file.
- Capability: 125B trunk / 6B active plus 51B PLE and 4B native MTP; text,
  image and video input remain enabled.
- Context ceiling: 131,072 tokens; output ceiling: 32,768 tokens. The model's
  unscaled native limit remains 262,144 tokens.
- Quality safeguards: KV cache quantization and decode-attention quantization
  are disabled. MTP is greedy-equivalent speculative decoding and is allowed
  to adapt its depth; it does not replace the target model's logits.
- Residency target: roughly 75 GB of model weights, with the PLE table mmaped
  instead of occupying another 32 GB of GPU-addressable memory.
- Prefix cache: 4 GB RAM, 100 GB disk, 64 entries.
- Metal wired-memory limit: the Apple default (`iogpu.wired_limit_mb=0`). The
  launcher refuses to run if a custom system limit is active.

The model endpoint binds to port 8080 and requires a dedicated Keychain-backed
bearer token separate from the Nexus control-plane token. The MBA reaches it over
the direct Thunderbolt address; the public internet is never an advertised
route. Tailnet addresses remain in machine-local environment files rather than
the public repository.

## Ownership

- MBA owns the control plane.
- MBP owns large-model inference.
- Z13 owns Linux execution and its smaller coding model.

`run-control.sh` refuses to start outside the MBA. This prevents the old MBP
state directory from becoming a second control plane.

## Lifecycle

```bash
launchctl kickstart -k gui/$(id -u)/ai.nexus.local-agent.mlx-serve
launchctl kickstart -k gui/$(id -u)/ai.nexus.local-agent.inference
curl http://127.0.0.1:8080/health
```

The launch agents are installed from:

- `ops/macos/ai.nexus.local-agent.mlx-serve.plist`
- `ops/macos/ai.nexus.local-agent.inference.plist`

`ops/macos/run-mlx-serve.sh` validates the model layout, native context and PLE
file size before startup. It reads the model API key from Keychain. The older
oMLX runner and its original Jundot checkpoint remain an offline reference for
quality regression checks; they are not a second active model-server owner.
Custom Metal-limit launch daemons are forbidden.

`ops/macos/com.nexus.power-policy.plist` keeps clamshell inference awake on AC
power and restores normal sleep within ten seconds of switching to battery.

## Verified performance and limits

Validated on the M5 Max 128 GB MBP with the exact pinned revision above:

- Download integrity: all 113 files matched the publisher's sizes; all 103 LFS
  files (107.316 GB) matched their published SHA-256 digests.
- Observed steady server RSS after a launch-agent restart: about 61.9 GB. The
  runtime preflight counted 70.13 GB of model weights; the 32 GB PLE file stayed
  mmaped.
- Korean reasoning: a 552-token deterministic answer decoded at 80.7 tok/s and
  solved the all-labels-wrong fruit-box problem correctly.
- Exact acceleration check: the first 50 primes were correct and byte-identical
  with MTP enabled and disabled. MTP increased decode from 63.1 to 112.9 tok/s
  for that request.
- Tool use: emitted a schema-valid `get_weather` call and consumed the tool
  result into a correct final answer.
- Coding: generated a longest-valid-parentheses implementation that passed six
  isolated JavaScript tests at 106.5 tok/s.
- Vision: correctly described a 512 x 311 beach illustration, including the
  sunset and diagonal colour bands.
- Long context: recovered a needle from 68,048 tokens at 886.8 prefill tok/s,
  then recovered a different needle from 120,053 tokens at 744.4 prefill tok/s.
  The latter reached 20% reported memory headroom, added no swap, and recovered
  to more than 80% headroom after completion.
- Service recovery: a forced model-service restart loaded a new process and
  returned a successful inference in 10 seconds; a forced node-daemon restart
  restored its health endpoint in 5 seconds with no API-key field exposed.

The full host-reboot recovery and the MBA control-plane-to-MBP inference path
remain unverified until a real reboot is approved and the MBA is online.

## Recovery checks

After an mlx-serve restart, wait for `/v1/models` to list the mixed 4/8-bit
model, then run one deterministic chat request through the MBA `nexus-auto`
gateway. After
a host reboot, additionally verify `sysctl iogpu.wired_limit_mb` returns `0`,
the model service recovers without operator input, and both nodes are `online`
in the MBA registry. A reboot-recovery claim remains unverified until that real
test has been observed.
