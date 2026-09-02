# Codex handoff

This file is the implementation handoff for continuing `nexus-local-agent`. Read it together with `ARCHITECTURE.md` and `TOOLS.md` before changing core contracts.

## Current objective

Build one persistent local agent identity over heterogeneous machines:

- **MacBook Air M4 16GB** — primary control plane; no LLM required.
- **MBP M5 Max 128GB** — heavy multimodal inference appliance, expected primary model: Qwen3.8-Flash-Next-class OpenAI-compatible mlx-serve/oMLX endpoint.
- **ROG Flow Z13 64GB Linux** — primary Linux executor plus coding/fallback model.
- **Hong Kong Mac mini M4 16GB** — model-less WAN macOS executor, HK network presence, CI, future DR standby.

Do not optimize this system by pretending the machines share accelerator memory. Optimize it as a heterogeneous agent fabric.

## Implemented baseline

The branch/main baseline after this handoff includes:

- dynamic node registration/heartbeats;
- capability and region/platform routing;
- separate inference and execution route decisions;
- native OpenAI-compatible multimodal/function-calling model client;
- native tool registry;
- node tool runtime for shell/fs/git/code/documents/browser/computer-use;
- screenshot -> vision input feedback in the agent loop;
- control tools for web search/fetch, Deep Research, persistent memory, delegation, node status;
- dependency-aware in-process parallel DAG execution;
- planner -> executor -> verifier -> repair/re-plan lifecycle;
- child-task delegation with max depth 4;
- OpenAI-compatible `/v1/chat/completions` gateway with passthrough client tools;
- unit tests and GitHub Actions typecheck/test.

## Non-negotiable invariants

1. **Inference != execution.** Never require a tool to execute on the machine hosting the model.
2. **Capabilities, not host names.** Hardware-specific defaults belong in deployment config; runtime selection uses capabilities/metrics/constraints.
3. **The Air owns control state.** Do not put required control state in M5 model memory or Z13 local process state.
4. **Control tools and node tools stay distinct.** This prevents unnecessary WAN hops and keeps node daemons small.
5. **Screenshots flow back to the multimodal model.** Preserve `ToolResult.images` through the executor.
6. **No fake completion.** An autonomous step should finish only after tool-backed evidence; task success requires verifier PASS.
7. **No human approval gate in the normal loop.** Network authentication and capability routing remain in force.
8. **Preserve OpenAI compatibility.** mlx-serve/llama.cpp and external frontends should remain replaceable.

## Package ownership

- `packages/protocol`: wire schema only. Avoid runtime dependencies.
- `packages/provider`: model protocol adapter only. Do not add task orchestration here.
- `packages/tools`: tool metadata/JSON schemas, not host implementation.
- `apps/node-daemon`: host implementations of node-scoped tools.
- `packages/research`: search/fetch/research workflow.
- `packages/memory`: memory persistence/search.
- `packages/router`: pure route scoring/filtering.
- `packages/executor`: model <-> tool interaction loop.
- `packages/orchestrator`: plan/verify prompts and schemas.
- `apps/control-plane/src/fabric.ts`: task lifecycle and control-tool composition.
- `apps/control-plane/src/index.ts`: HTTP transport only; move complex behavior into services instead of growing this file.

## Validation before every merge

```bash
corepack enable
corepack prepare pnpm@10.17.1 --activate
pnpm install
pnpm typecheck
pnpm test
```

Do not claim browser execution is tested merely because unit CI is green. CI skips Chromium download. On a real executor node also run:

```bash
pnpm exec playwright install chromium
```

and execute a browser smoke task.

For physical computer-use, separately validate the actual desktop session because CI cannot grant macOS Accessibility/Screen Recording or emulate the user's Linux Wayland/X11 environment.

## Deployment expectations

### Air

Run control plane as a persistent service (`launchd` is the intended macOS deployment direction). Back up `.state/` because it contains task/event and memory databases. Search-provider secrets remain only on the control plane.

### M5 Max

Keep background load minimal. Run the OpenAI-compatible multimodal model service and a lightweight node daemon that advertises `inference`. The model URL must be reachable from the Air; do not advertise `127.0.0.1` as the model URL when the Air is remote.

### Z13

Advertise `inference,exec,fs,git,containers,browser,computer,code,documents,ci,long-running`. Install Chromium and the required Linux desktop input/capture utilities. The model service and executor are independent even though they share this host.

### HK mini

Use a private tailnet/WireGuard path. Advertise model-less execution capabilities and `region=hk`. Do not expose node-daemon port 7790 publicly.

## Highest-priority next implementation work

### P0 — scheduler durability

Replace in-memory DAG progress with persisted step records and leases:

- step states and attempt numbers;
- lease owner / lease expiry;
- idempotency key per tool/step execution where applicable;
- task cancellation;
- crash/restart resume;
- per-node concurrency budgets.

The current DAG parallelism is correct for one healthy control process but is not crash-durable.

### P0 — repository ownership

Connect `packages/worktree` to execution scheduling:

- allocate one worktree per write-capable child/step;
- sync/clone repository to remote executors;
- define branch/commit handoff protocol;
- prevent two parallel agents from mutating the same checkout;
- deterministic merge/rebase and conflict escalation to verifier.

### P1 — adaptive routing

Feed observed metrics into routing instead of relying mainly on static classes:

- model prompt/decode latency and tokens/sec EWMA;
- model/tool error rates;
- node active jobs/load/free memory;
- WAN latency/availability;
- task-kind historical success rate.

Keep hard capability/platform/region filters before scoring.

### P1 — observability

Add SSE/WebSocket event streaming plus an operator UI showing:

- task DAG and retries;
- live inference/execution routing;
- tool calls/results;
- screenshot timeline;
- model/token/latency metrics;
- node health and current jobs.

### P1 — control-plane DR

Replicate task/event/memory state to HK and implement standby leadership. Do not use one SQLite file over WAN. Use an event/replication protocol or migrate to a replicated database when justified.

### P2 — richer execution backends

- optional container/microVM backend for `code.run` while preserving unrestricted user intent;
- Wayland-native `uinput`/`ydotool` adapter;
- layout-aware PDF/Office parsing and rendered-page vision fallback;
- optional Stagehand/browser-agent adapter behind a browser interface, not as the core orchestration layer.

## Known intentional limitations

- `code.run` is host execution, not sandboxed.
- Browser Chromium is not installed by package install/CI automatically.
- Physical computer-use is platform/session dependent.
- Deep Research citation audit validates source IDs, not semantic entailment of every claim.
- Search requires at least one configured provider.
- No persisted task leases/cancellation/resume yet.
- No state replication/failover yet.
- No committed generated pnpm lockfile yet.

These must remain visible in documentation and should not be silently papered over.

## Definition of done for the next Codex pass

For each major change:

1. preserve the invariants above;
2. add or update protocol schemas first when the wire contract changes;
3. add unit tests for pure logic;
4. add integration/smoke coverage where host services are involved;
5. run `pnpm typecheck` and `pnpm test`;
6. verify generated runtime endpoints manually when the feature depends on browser/desktop/model services;
7. update this handoff if a known limitation becomes implemented or a new invariant is introduced.
