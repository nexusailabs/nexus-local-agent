# Nexus Local Agent architecture

## Design goal

Treat two heterogeneous machines as one autonomous agent **without** pretending that Thunderbolt is shared VRAM.
The normal execution path moves task state, prompts, diffs and tool results across TB4; model tensors stay local.

## Planes

1. **Inference plane** — native model server per node (oMLX on Apple Silicon, llama.cpp Vulkan/ROCm on Strix Halo).
2. **Execution plane** — `node-daemon` exposes authenticated process/filesystem primitives on the trusted point-to-point link.
3. **Control plane** — durable task/event store, capability-based routing and agent state machine.
4. **Compatibility plane** — OpenAI-compatible `/v1` endpoint so Pi, OpenCode, IDEs and custom clients see one logical model.

## Invariants

- No human approval gate is required for routine tool execution.
- Network authentication is mandatory; "unattended" must not mean "unauthenticated remote shell".
- Every mutating coding task should get an isolated Git worktree.
- Planning and verification should preferentially route to the strongest independent model.
- Execution should preferentially route to the worker node to preserve MBP capacity for orchestration and interactive work.
- State transitions and evidence are append-only events in SQLite WAL.
- Model identity is configuration, not application logic.

## Target state machine

`queued -> planning -> running -> verifying -> succeeded`

Failures enter `repairing`, increment an attempt counter, receive verifier findings, and return to `running` until the attempt budget is exhausted.

## Why llama.cpp RPC is not the default

RPC is retained as an experimental `cluster-model` backend for models that do not fit either node alone. It should be explicitly selected per task. The main runtime never assumes RPC availability.

## Near-term roadmap

- DAG scheduler with per-step leases and retries.
- HTTP/SSE task event stream.
- model-server health/latency probing and EWMA routing.
- remote execution adapter against node-daemon.
- Git worktree lifecycle integrated with tasks.
- structured tool protocol and artifact/evidence capture.
- repair loop and independent verifier quorum.
- mDNS discovery with static TB4 address fallback.
- optional speculative/draft service experiments.
- optional llama.cpp RPC monolithic-mode adapter.
- Pi extension and TUI as clients, not runtime dependencies.
