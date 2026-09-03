# Z13 worker-first execution

## Outcome

OMP and other MCP-capable harnesses can submit one objective that is planned and verified by MBP Qwen Next while ordinary execution runs on Z13. Small work uses one remote step; larger independent work can run in parallel.

## Acceptance

- Live inference routes select `mbp-m5-max`.
- Live platform-neutral execution routes select `z13-strix-halo` while both nodes are online.
- `nexus_run_task` invokes the planner-executor-verifier lifecycle.
- Returned evidence names both inference and execution nodes.
- If Z13 is unavailable, MBP remains a routable fallback executor.
- OMP's local Qwen instructions prefer `nexus_run_task` for autonomous work.

## Boundary

Cross-node repository materialization is not hidden by this change. A supplied repository path must already exist on the selected node until the workspace-distribution backlog item is implemented.
