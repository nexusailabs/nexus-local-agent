# Architecture

## Principle: agent fabric, not distributed tensor memory

Nexus Local Agent treats heterogeneous machines as independently useful resources. It does not assume that RAM or accelerators across machines should behave like one GPU.

The control plane routes **intent, tokens, commands, diffs and evidence**. Tensor/model parallelism is an optional experimental backend, not the system architecture.

## Planes

### Control plane

Primary target: MacBook Air M4 16GB.

Responsibilities:

- durable task/event state
- live node registry
- heartbeat lease expiry
- task planning and verification orchestration
- inference/execution routing
- OpenAI-compatible gateway
- future DAG leases, retries and failover

The control plane runs no required LLM.

### Inference plane

Primary targets:

- MBP M5 Max 128GB: heavy reasoning/review/long-context model.
- Z13 64GB Linux: coding/tool model.

Inference nodes advertise one or more model endpoints and model-level capabilities.

### Execution plane

Primary targets:

- Z13: Linux shell, Git, containers, builds, tests and browser automation.
- Hong Kong M4 Mac mini: remote macOS CI, browser/network checks, long-running jobs and standby infrastructure.

Execution nodes may advertise **zero models**.

## Dynamic registry

Every node-daemon registers a `NodeSpec` and refreshes a heartbeat.

```text
REGISTER --> registry entry
HEARTBEAT every 10s
        |
        +-- lastSeen <= TTL --> online / routable
        +-- lastSeen >  TTL --> stale / excluded
```

The default TTL is 45 seconds. Bootstrap entries are only a recovery/static-lab escape hatch; normal operation is self-registration.

## Capability model

Node capabilities describe tools/resources:

- `inference`
- `exec`, `fs`, `git`
- `containers`, `browser`, `ci`
- `network-probe`, `long-running`
- `control`, `control-standby`

Model capabilities independently describe intelligence:

- `reasoning`, `coding`, `tool-use`
- `vision`, `long-context`, `fast-draft`, `review`

There is no `brain` or `worker` role in the routing contract.

## Split routing

For a step, the router separately selects:

1. an inference node/model based on model capabilities, quality, speed, reliability and reachability;
2. an execution node based on required node capabilities, platform, region, execution class, reliability and reachability.

This allows a large M5 model to operate a Z13 shell or a Hong Kong Mac mini without pretending those machines share accelerator memory.

## Region/platform constraints

`PlanStep.execution` can require:

- node capabilities
- preferred capabilities
- platform
- region
- avoided nodes

A planner can therefore emit a clean macOS/Hong-Kong verification step while using a model hosted elsewhere.

## Security boundary

Unattended execution and unauthenticated remote execution are different concerns. Node-daemon execution does not require a human approval prompt, but control traffic requires the shared bearer token and should traverse trusted LAN/TB4 or WireGuard/Tailscale rather than public port forwarding.

## Next implementation layer

1. Durable DAG scheduler with dependency-aware parallelism.
2. Work leases and idempotent retries.
3. Verifier-driven repair loop.
4. Worktree/repository distribution across executor nodes.
5. EWMA latency/throughput/load feedback into routing.
6. Event streaming and observability UI.
7. Replicated state and HK standby control-plane failover.
