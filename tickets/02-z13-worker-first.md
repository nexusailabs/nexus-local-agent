# Z13 worker-first execution

## Outcome

OMP and other MCP-capable harnesses can submit one objective that is planned and verified by MBP Qwen Next while ordinary execution runs on Z13. Small work uses one remote step; larger independent work can run in parallel.

## Acceptance

- Planning and verification inference select `mbp-m5-max`; Z13-executed step inference selects the Z13 model.
- Live platform-neutral execution routes select `z13-strix-halo` while both nodes are online.
- `nexus_run_task` invokes the planner-executor-verifier lifecycle.
- Returned evidence names both inference and execution nodes.
- If Z13 is unavailable, MBP remains a routable fallback executor.
- Z13 execution prefers TB4 and automatically falls back to Tailscale without replaying a started side effect.
- OMP's local Qwen instructions prefer `nexus_run_task` for autonomous work.

## Boundary

Cross-node repository materialization is not hidden by this change. A supplied repository path must already exist on the selected node until the workspace-distribution backlog item is implemented.
