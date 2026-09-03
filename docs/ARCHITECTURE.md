# Architecture

## Principle: agent fabric, not distributed tensor memory

Nexus treats heterogeneous machines as independently useful resources. The normal path sends **intent, model tokens, tool calls, screenshots, diffs, evidence and task state** between nodes. It does not move model layers across the network on every decode step.

Tensor/model parallelism may exist later as an experimental backend, but it is not the agent architecture.

## Three planes

### Control plane

Primary target: MacBook Air M4 16GB.

Responsibilities:

- live node registry and heartbeat TTL
- durable SQLite task/event state
- dependency-aware task DAG execution
- bounded parallel ready-step batches
- planner/verifier orchestration
- automatic repair and re-plan attempts
- independent inference/execution routing
- control-scoped tools: web search/fetch, Deep Research, memory, node status, delegation
- OpenAI-compatible gateway

The control plane requires no local LLM.

### Inference plane

Primary targets:

- MBP M5 Max 128GB: heavy multimodal reasoning, planning, review, long context.
- Z13 Linux 64GB: coding/tool model and fallback inference.

Inference nodes advertise OpenAI-compatible model endpoints and model-level capabilities. The model endpoint must be reachable from the control plane.

### Execution plane

Primary targets:

- Z13: Linux shell, filesystem, Git, code, builds/tests, browser and physical computer-use.
- Hong Kong M4 Mac mini: remote macOS/browser/CI, HK network presence, long jobs and future standby control.

Execution nodes may advertise **zero models**.

### Default dual-node policy

- MBP is the planning, inference, and independent verification node.
- Z13 is the first-choice execution worker for platform-neutral shell, filesystem, Git, code, build, test, browser, container, CI, and long-running work.
- MBP remains an executor only for macOS/Metal-specific work and automatic Z13 outage fallback.
- Tiny work uses one Z13 execution step. Larger work is split only across genuinely independent DAG steps, up to the configured parallelism, so task splitting improves throughput instead of adding ceremony.
- Interactive harnesses enter this lifecycle through `nexus_run_task`; direct chat completion alone is inference and does not imply distributed execution.

## Hard invariants

1. **Do not collapse inference and execution.** A model may run on M5 while its tools execute on Z13 or HK mini.
2. **Node capabilities describe resources; model capabilities describe intelligence.** Keep them separate.
3. **Tool schemas are first-class protocol.** MCP is an optional adapter, not the internal abstraction.
4. **Control-scoped tools never need to round-trip through a node daemon.** Node-scoped tools always execute through a capability-checked node daemon.
5. **Screenshots are model inputs.** `ToolResult.images` are appended to the next model turn as high-detail data-URI image inputs.
6. **Completion is evidence-based.** Tool execution results feed the agent transcript and the independent verifier.
7. **Human approval is not part of the normal tool-call loop.** Transport authentication remains mandatory.

## Dynamic registry

Every node-daemon registers a `NodeSpec` and refreshes heartbeat metrics including free memory, load, uptime and active jobs.

```text
REGISTER -> registry entry
HEARTBEAT
    |
    +-- lastSeen <= TTL -> online / routable
    +-- lastSeen > TTL  -> stale / excluded
```

Bootstrap entries remain a recovery/static-lab escape hatch.

## Capability model

Node capabilities currently include:

- `inference`
- `exec`, `fs`, `git`
- `containers`, `browser`, `computer`, `code`, `documents`
- `ci`, `network-probe`, `long-running`
- `control`, `control-standby`

Model capabilities independently include:

- `reasoning`, `coding`, `tool-use`
- `vision`, `long-context`, `fast-draft`, `review`

There is no `brain` / `worker` role in the routing contract.

## Split routing and tool loop

For each step:

```text
PlanStep
  |-- inference route -> node + model
  `-- execution route -> node
             |
             v
      model tool call
             |
      +------+----------------+
      |                       |
control-scoped tool      node-scoped tool
(Air)                    (Z13/HK/...)
      |                       |
      +----------+------------+
                 v
           ToolResult
                 |
        text + optional image
                 |
                 v
            next model turn
```

This is how a multimodal M5 model can visually operate a browser or physical desktop hosted elsewhere.

## Task lifecycle

```text
queued
  -> planning
  -> running (DAG-ready batches may run concurrently)
  -> verifying
       |-- PASS -> succeeded
       `-- FAIL -> repairing -> re-plan -> running
                              ... up to maxAttempts
```

`agent.delegate` creates a normal child task with parent/depth metadata and runs it through the same planning/execution/verification lifecycle. Delegation depth is bounded to prevent unbounded recursive task trees.

## Deep Research

Deep Research is a control-plane workflow, not a single external MCP tool:

1. local model decomposes the question into diverse queries;
2. configured search providers run in parallel per query;
3. URLs are normalized/deduplicated;
4. a second round can target evidence gaps;
5. top sources are fetched and readable text extracted;
6. local model synthesizes only from supplied evidence with `[S#]` citations;
7. citation IDs are audited; one citation-repair pass is attempted; invalid/no citation output fails.

Search backends: SearXNG, Brave Search, Tavily, Exa.

## Browser versus computer-use

Prefer deterministic browser/DOM operations first. The Playwright node backend maintains explicit browser sessions and supports navigate/click/type/extract/screenshot. Use physical computer-use when the state is outside a browser DOM or deterministic browser operations are insufficient.

Physical computer-use backends are deliberately small platform adapters. On macOS they use `screencapture`, Accessibility/System Events, and CoreGraphics/Swift for pointer/scroll events. Linux currently uses `grim` or `gnome-screenshot` plus `xdotool`/`wtype` where available.

## Durable state

- task/events: SQLite WAL in the control-plane state directory;
- memory: separate SQLite WAL store with FTS5 if available;
- model/tool transcripts: currently persisted indirectly through task events/evidence rather than a dedicated transcript table.

## Security and operations boundary

Unattended execution and unauthenticated remote execution are different concerns. Nexus intentionally has no human confirmation gate in the tool loop, but node/control RPC requires the shared bearer token and should travel over trusted LAN/TB4 or WireGuard/Tailscale. Do not public-port-forward the execution API.

`code.run` is currently host execution, not a security sandbox. Container-backed isolation can be added as a policy/backend without changing the tool contract.

## Production backlog

The current branch establishes a functional tool fabric, not a finished production scheduler. Highest-value next work:

1. persisted task/step leases, idempotency keys, cancellation and crash-safe resume;
2. repository/worktree distribution and conflict-safe parallel write ownership (until this lands, `repoPath` must already exist on the routed execution node);
3. EWMA latency, tokens/sec, failure rate and active-load feedback in routing;
4. SSE/WebSocket event stream and operator UI;
5. control-plane state replication and HK standby leader election/failover;
6. optional container/microVM execution backend for `code.run` and risky build jobs;
7. layout-aware PDF/Office parsers plus rendered-page vision fallback;
8. browser adapter interface for optional Stagehand/other agent-browser backends;
9. screenshot/action trace storage and computer-use replay/debugging;
10. generated and committed dependency lockfile plus release/versioning pipeline.
