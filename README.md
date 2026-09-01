# nexus-local-agent

Dual-node local autonomous-agent runtime for a heterogeneous Apple Silicon + AMD Strix Halo cluster.

The key design choice is **agent parallelism over tensor parallelism**: each node runs the inference stack it is best at, while one durable control plane routes planning, implementation, build/test and verification work across the Thunderbolt point-to-point network.

## Initial target hardware

- Brain: MacBook Pro M5 Max 128GB — oMLX / Metal, large reasoning/review model.
- Worker: ROG Flow Z13 Ryzen AI Max+ 395 64GB Linux — llama.cpp Vulkan/ROCm, dense coding/tool model.

## Repository layout

- `apps/control-plane` — task API, SQLite event store, router/orchestrator, OpenAI-compatible gateway.
- `apps/node-daemon` — authenticated local process and filesystem execution service.
- `packages/protocol` — Zod wire contracts.
- `packages/provider` — OpenAI-compatible inference adapter.
- `packages/router` — capability/quality/speed/role based routing.
- `packages/orchestrator` — planner and independent verifier.
- `packages/worktree` — isolated Git worktree lifecycle.
- `config/nodes.yaml` — hardware/model topology.
- `scripts/` — deterministic TB4 point-to-point networking helpers.

## Bootstrap

```bash
corepack enable
pnpm install
cp .env.example .env
# replace NEXUS_SHARED_TOKEN
pnpm typecheck
```

### MBP

Run the preferred oMLX server on `127.0.0.1:8080`, configure the Thunderbolt Bridge with `scripts/tb4-macos.sh`, then:

```bash
export NEXUS_NODE_ID=mbp-m5-max NEXUS_NODE_ROLE=brain NEXUS_NODE_PORT=7790
pnpm dev:node
pnpm dev:control
```

### Z13 Linux

Run the preferred llama.cpp server on `127.0.0.1:8081`, identify the Thunderbolt networking interface, then:

```bash
./scripts/tb4-linux.sh <iface>
export NEXUS_NODE_ID=z13-strix-halo NEXUS_NODE_ROLE=worker NEXUS_NODE_PORT=7790
pnpm dev:node
```

The default topology uses `169.254.77.1/24` for the MBP and `169.254.77.2/24` for the Z13.

## API

```bash
curl -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" http://127.0.0.1:7788/v1/nodes

curl -X POST http://127.0.0.1:7788/v1/tasks \
  -H "Authorization: Bearer $NEXUS_SHARED_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"objective":"Audit this repository and fix failing tests","repoPath":"/path/to/repo","kind":"code"}'
```

Any OpenAI-compatible client can target `http://127.0.0.1:7788/v1` with model `nexus-auto`.

## Current status

This is the foundation, not a claim of production readiness. Durable task creation, planning, model routing, node execution primitives and verification contracts exist; the full executor/DAG/repair loop is the next implementation layer.
