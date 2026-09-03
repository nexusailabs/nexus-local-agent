# nexus-local-agent

Heterogeneous **N-node autonomous agent fabric** for local and remote machines. Nexus keeps orchestration, inference, and execution separate so each machine can do the job it is best at without pretending heterogeneous RAM/accelerators are one GPU.

## Target topology

```text
MacBook Air M4 16GB
PRIMARY CONTROL PLANE
registry / task DAG / state / research / memory / API
          |
          +-------------------+----------------------------+
          | LAN               | LAN / TB4                  | WAN / tailnet
          v                   v                            v
MBP M5 Max 128GB        Z13 Linux 64GB              HK Mac mini M4 16GB
INFERENCE               INFERENCE + EXECUTOR        REMOTE EXECUTOR / DR
Qwen Flash-Next class   coding model + tools        clean macOS / HK network
```

The Air and Hong Kong mini do not need local LLMs. The M5 Max can remain an inference appliance. The Z13 is the primary Linux execution node. The Hong Kong mini is a model-less remote macOS/region executor.

## What is implemented

- Dynamic N-node registration and heartbeat leases.
- Independent **inference routing** and **execution routing**.
- OpenAI-compatible `nexus-auto` gateway with multimodal messages and native function/tool calls.
- Dependency-aware task DAG execution with bounded parallel ready-step batches.
- Planner -> tool execution -> independent verifier -> automatic repair/re-plan loop.
- Verified child-task delegation with bounded delegation depth.
- First-class native tool catalog; MCP is not required.
- Stateful Playwright Chromium browser sessions.
- Vision computer-use loop: screenshot results are fed back to the inference model as image inputs.
- Physical desktop screenshot/click/type/key/scroll/open-app backends for macOS and Linux.
- Shell, filesystem, Git, code execution, and document-reading primitives.
- Multi-provider Deep Research with query decomposition, search fan-out, gap rounds, source fetch, synthesis, and citation-ID validation.
- Durable SQLite/WAL memory with FTS5 when available and a LIKE fallback.
- Durable task/event log in SQLite/WAL.
- Platform/region constraints such as `darwin-arm64` or `region=hk`.
- Authenticated unattended execution: no human approval gate is required for a tool call, but network transport stays authenticated.

See [docs/TOOLS.md](docs/TOOLS.md) for the tool contract and [docs/CODEX_HANDOFF.md](docs/CODEX_HANDOFF.md) before extending the runtime.

## Repository layout

- `apps/control-plane` — live registry, task fabric, research/memory control tools, OpenAI-compatible gateway.
- `apps/node-daemon` — node registration/heartbeat plus native execution tools.
- `apps/mcp-adapter` — compact stdio tools for Claude, Codex, and OMP to execute on registered nodes without opening SSH sessions.
- `packages/protocol` — wire contracts and capability schemas.
- `packages/provider` — OpenAI-compatible multimodal/tool-calling model adapter.
- `packages/tools` — first-class tool registry and model-facing JSON schemas.
- `packages/research` — search providers, fetch/extraction, Deep Research and citation audit.
- `packages/memory` — durable memory store.
- `ops/macos/model-route-proxy.mjs` — direct HTTP streaming routes from the MBA to both model APIs, with TB4 priority and automatic Tailscale fallback.
- `ops/macos/z13` — authenticated MBA-side CLI for Z13 execution plus one-file-at-a-time private HTTP transfers that avoid argv and daemon body-size limits.
- `packages/router` — independent inference/execution routing.
- `packages/orchestrator` — planner and verifier.
- `packages/executor` — function-calling agent loop and screenshot -> vision feedback.
- `packages/worktree` — Git worktree lifecycle foundation.
- `config/cluster.yaml` — control policy and optional bootstrap/recovery nodes.
- `ops/` and `scripts/` — host/network operational helpers.

## Bootstrap

Requires Node.js 24+ and pnpm 10.17.1.

```bash
corepack enable
corepack prepare pnpm@10.17.1 --activate
pnpm install
cp .env.example .env
# replace NEXUS_SHARED_TOKEN
pnpm typecheck
pnpm test
```

Nodes that advertise `browser` also need the browser binary:

```bash
pnpm exec playwright install chromium
```

## Node profiles

### MacBook Air — primary control plane

No model server is required.
The deployed `run-control.sh` verifies the Air's tailnet address before opening
the state database, preventing an old MBP checkout from creating a split-brain
control plane.

```bash
export NEXUS_SHARED_TOKEN='...'
export NEXUS_CONFIG=config/cluster.yaml
export NEXUS_TASK_PARALLELISM=3
pnpm dev:control
```

For Deep Research, configure at least one search backend. A self-hosted SearXNG endpoint is the simplest default; Brave, Tavily and Exa adapters are also implemented.

```bash
export NEXUS_SEARXNG_URL='http://...'
# or BRAVE_SEARCH_API_KEY / TAVILY_API_KEY / EXA_API_KEY
```

### M5 Max — inference-only node

Run mlx-serve/another OpenAI-compatible server first. `baseUrl` in
`NEXUS_MODELS_JSON` must be reachable from the Air control plane.

The quality-first MBP profile uses mlx-serve 26.8.11 with
`ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`. Routed experts stay at
4-bit group 64, while attention, GDN, hyper-connections, indexer, shared
experts, LM head and MTP are 8-bit group 64. The publisher's exact 32 GB PLE
table is mmaped, targeting about 75 GB resident instead of loading that table
onto the GPU. Vision stays enabled. The serving ceiling is 131,072 context and
32,768 output tokens; KV and decode-attention quantization are disabled.
Native MTP accelerates decoding without replacing the target logits.
`ops/macos/run-mlx-serve.sh` reads a dedicated model API key from Keychain,
separate from the control-plane token. The key is injected only into the
server process. The runner refuses a custom `iogpu.wired_limit_mb`, an
incomplete download, or an incompatible model layout.

```bash
export NEXUS_CONTROL_URL='http://mba-m4-control.local:7788'
export NEXUS_NODE_ID='mbp-m5-max'
export NEXUS_NODE_BASE_URL='http://mbp-m5-max.local:7790'
# Optional ordered routes: prefer TB4, fall back to Tailscale, and promote back
# to TB4 automatically when the cable returns.
export NEXUS_CONTROL_ROUTES_JSON='[
  {"name":"tb4","controlUrl":"http://169.254.77.3:7788","nodeBaseUrl":"http://169.254.77.1:7790"},
  {"name":"tailscale","controlUrl":"http://100.81.53.61:7788","nodeBaseUrl":"http://100.107.237.37:7790"}
]'
export NEXUS_NODE_CAPABILITIES='inference'
export NEXUS_NODE_TAGS='apple-silicon,metal,mlx'
export NEXUS_EXECUTION_CLASS=10
export NEXUS_MODELS_JSON='[
  {
    "id":"Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit",
    "provider":"mlx-serve",
    "baseUrl":"http://mbp-m5-max.local:8080/v1",
    "contextWindow":262144,
    "maxOutputTokens":32768,
    "capabilities":["reasoning","coding","tool-use","long-context","review","vision"],
    "costClass":70,
    "speedClass":94,
    "qualityClass":98
  }
]'
pnpm dev:node
```

### Z13 Linux — inference + primary executor

```bash
export NEXUS_CONTROL_URL='http://mba-m4-control.local:7788'
export NEXUS_NODE_ID='z13-strix-halo'
export NEXUS_NODE_BASE_URL='http://z13.local:7790'
export NEXUS_NODE_CAPABILITIES='inference,exec,fs,git,containers,browser,computer,code,documents,ci,long-running'
export NEXUS_NODE_TAGS='strix-halo,rocm,vulkan,tb4'
export NEXUS_EXECUTION_CLASS=96
# Set NEXUS_MODELS_JSON to a control-plane-reachable llama.cpp /v1 endpoint.
pnpm dev:node
```

Linux physical computer-use currently expects an available screenshot backend (`grim` or `gnome-screenshot`) and input backend (`xdotool`, with `wtype` used for typing when available).

### Hong Kong Mac mini — remote executor, no model

```bash
export NEXUS_CONTROL_URL='https://<tailnet-control-address>:7788'
export NEXUS_NODE_ID='hk-mac-mini'
export NEXUS_NODE_BASE_URL='https://<tailnet-hk-mini-address>:7790'
export NEXUS_NODE_CAPABILITIES='exec,fs,git,browser,computer,code,documents,ci,network-probe,long-running,control-standby'
export NEXUS_NODE_REACHABILITY='wan'
export NEXUS_REGION='hk'
export NEXUS_NODE_TAGS='macos,remote,hk'
export NEXUS_EXECUTION_CLASS=62
export NEXUS_MODELS_JSON='[]'
pnpm dev:node
```

macOS physical computer-use requires Screen Recording and Accessibility permission for the process/session running the node daemon. Keep the node daemon behind a trusted LAN/TB4 or WireGuard/Tailscale network; do not expose the execution port directly to the public Internet.

## API quick start

List the fabric and its tools:

```bash
curl -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" http://127.0.0.1:7788/v1/nodes
curl -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" http://127.0.0.1:7788/v1/tools
```

Run an autonomous task:

```bash
curl -X POST http://127.0.0.1:7788/v1/agent/run \
  -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "objective":"Audit this repository, fix failures, test on Linux, then delegate a clean macOS verification",
    "repoPath":"/path/to/repo",
    "kind":"code",
    "maxAttempts":4
  }'
```

Run Deep Research directly:

```bash
curl -X POST http://127.0.0.1:7788/v1/research \
  -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"query":"research question","maxRounds":2,"maxSources":12}'
```

Any OpenAI-compatible client can target `http://127.0.0.1:7788/v1` with model `nexus-auto`. Client-supplied function tools and multimodal image content are passed through to the selected local model.

Claude, Codex, and OMP can also launch `ops/macos/run-nexus-mcp.sh` as a stdio MCP server. The adapter defaults to `mbp-m5-max`, discovers its current registered address, and immediately retries the configured Tailscale route if the TB4 API is unavailable. It exposes node status, argv execution, text-file access, Git inspection, code execution, and document reading while keeping Kaia as a separate context service.

## Important runtime boundaries

- `code.run` currently executes on the selected host. It is **not** a container/security sandbox.
- Playwright is the deterministic browser backend. Stagehand is intentionally not a core dependency; add it behind an adapter if/when it provides a concrete advantage.
- `document.read` uses native text reads plus `pdftotext`/`pandoc` when installed; full layout-aware Office/PDF parsing is not implemented yet.
- Computer-use correctness depends on desktop/session state and OS accessibility/input backends.
- The task DAG is dependency-aware and parallel in-process, but task leases are not yet persisted for crash-safe resume.
- Control-plane failover/state replication to the Hong Kong mini is not implemented yet.
- The repository does not yet commit a generated `pnpm-lock.yaml`; CI intentionally installs with `--no-frozen-lockfile` until a lockfile is generated and reviewed.

These are explicit extension points, not hidden claims of production readiness.
