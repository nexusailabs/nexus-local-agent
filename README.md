# nexus-local-agent

Heterogeneous **N-node autonomous agent fabric** for local and remote machines.

The runtime deliberately separates three concerns:

1. **Control plane** — durable task state, scheduling, routing and observability.
2. **Inference plane** — large or specialized local models.
3. **Execution plane** — shell, Git, builds, tests, browser/CI and region-specific work.

A model does **not** have to run on the machine that executes its commands. That is the key architectural change from the original dual-node foundation.

## Target topology

```text
MacBook Air M4 16GB
PRIMARY CONTROL PLANE
scheduler / registry / state / UI
          |
          +-------------------+------------------------+
          | LAN               | LAN / TB4              | WAN / tailnet
          v                   v                        v
MBP M5 Max 128GB        Z13 Linux 64GB          HK Mac mini M4 16GB
INFERENCE               INFERENCE + EXECUTOR    REMOTE EXECUTOR / DR
large reasoning model   coding model + tools    clean macOS CI/browser
```

The Air and Hong Kong mini do not need local LLMs. The M5 Max can remain almost purely an inference appliance, while Z13 owns Linux execution and the Hong Kong mini supplies an independent remote macOS/region environment.

## Core properties

- Dynamic node registration and heartbeat leases.
- Capability advertisement rather than hard-coded `brain` / `worker` roles.
- Independent inference routing and execution routing.
- Nodes with zero models are first-class execution nodes.
- Platform and region constraints per plan step.
- OpenAI-compatible `nexus-auto` gateway.
- SQLite WAL task/event state.
- Authenticated unattended node execution.
- Static bootstrap nodes only as a recovery mechanism.

## Repository layout

- `apps/control-plane` — registry, task API, router/orchestrator and OpenAI-compatible gateway.
- `apps/node-daemon` — capability advertisement, heartbeat, process/filesystem execution.
- `packages/protocol` — wire contracts and node/model capability schemas.
- `packages/provider` — OpenAI-compatible inference adapter.
- `packages/router` — independent inference/execution routing.
- `packages/orchestrator` — planning and verification.
- `packages/executor` — model-driven command loop with split inference/execution targets.
- `packages/worktree` — isolated Git worktree lifecycle.
- `config/cluster.yaml` — control-plane policy and optional recovery bootstrap nodes.

## Bootstrap

```bash
corepack enable
pnpm install
cp .env.example .env
# replace NEXUS_SHARED_TOKEN
pnpm typecheck
pnpm test
```

### 1. MacBook Air — control plane

No model server is required.

```bash
export NEXUS_SHARED_TOKEN='...'
export NEXUS_CONFIG=config/cluster.yaml
pnpm dev:control
```

### 2. M5 Max — inference-only node

Run oMLX/another OpenAI-compatible server first. `baseUrl` in `NEXUS_MODELS_JSON` must be reachable from the Air control plane.

```bash
export NEXUS_CONTROL_URL='http://mba-m4-control.local:7788'
export NEXUS_NODE_ID='mbp-m5-max'
export NEXUS_NODE_BASE_URL='http://mbp-m5-max.local:7790'
export NEXUS_NODE_CAPABILITIES='inference'
export NEXUS_NODE_TAGS='apple-silicon,metal,mlx'
export NEXUS_EXECUTION_CLASS=10
export NEXUS_MODELS_JSON='[
  {
    "id":"Qwen3.8-Flash-Next",
    "provider":"omlx",
    "baseUrl":"http://mbp-m5-max.local:8080/v1",
    "contextWindow":65536,
    "maxOutputTokens":16384,
    "capabilities":["reasoning","coding","tool-use","long-context","review","vision"],
    "costClass":70,
    "speedClass":72,
    "qualityClass":96
  }
]'
pnpm dev:node
```

### 3. Z13 — inference + Linux executor

```bash
export NEXUS_CONTROL_URL='http://mba-m4-control.local:7788'
export NEXUS_NODE_ID='z13-strix-halo'
export NEXUS_NODE_BASE_URL='http://z13.local:7790'
export NEXUS_NODE_CAPABILITIES='inference,exec,fs,git,containers,browser,ci,long-running'
export NEXUS_NODE_TAGS='strix-halo,rocm,vulkan,tb4'
export NEXUS_EXECUTION_CLASS=96
# Set NEXUS_MODELS_JSON to the reachable llama.cpp /v1 endpoint.
pnpm dev:node
```

### 4. Hong Kong Mac mini — remote executor, no model

```bash
export NEXUS_CONTROL_URL='https://<tailnet-control-address>:7788'
export NEXUS_NODE_ID='hk-mac-mini'
export NEXUS_NODE_BASE_URL='https://<tailnet-hk-mini-address>:7790'
export NEXUS_NODE_CAPABILITIES='exec,fs,git,browser,ci,network-probe,long-running,control-standby'
export NEXUS_NODE_REACHABILITY='wan'
export NEXUS_REGION='hk'
export NEXUS_NODE_TAGS='macos,remote,hk'
export NEXUS_EXECUTION_CLASS=62
export NEXUS_MODELS_JSON='[]'
pnpm dev:node
```

## Runtime API

```bash
curl -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  http://127.0.0.1:7788/v1/nodes

curl -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  'http://127.0.0.1:7788/v1/routes/plan'

curl -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  'http://127.0.0.1:7788/v1/routes/test?mode=execution'
```

Create a task:

```bash
curl -X POST http://127.0.0.1:7788/v1/tasks \
  -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "objective":"Audit this repository, fix failing tests, then run an independent clean macOS test",
    "repoPath":"/path/to/repo",
    "kind":"code",
    "execute":true
  }'
```

Any OpenAI-compatible client can target `http://127.0.0.1:7788/v1` with model `nexus-auto`.

## Routing model

For every executable plan step the fabric makes two independent decisions:

```text
step
  +--> inference route -> model node
  |
  +--> execution route -> tool node
```

Examples:

- planning: M5 Max model, no command required yet.
- Linux implementation: Z13 model + Z13 execution.
- heavy review that runs tests: M5 Max model + Z13 execution.
- clean Hong Kong macOS CI: selected model + HK mini execution.
- HK network probe: selected model + HK mini execution with `region=hk`.

## Current boundary

This refactor establishes the N-node substrate. The task runner is still sequential after planning; durable DAG leases, concurrent workers, automatic repair/retry, state replication and control-plane failover are the next layer.
