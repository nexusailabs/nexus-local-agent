# Distributed repository workspaces

## Outcome

A repository task submitted from OMP on the MBA is snapshotted to isolated Z13 workspaces, executed there, and returned as a conflict-checked patch that updates the source repository.

## Acceptance

- Snapshot includes tracked files, current tracked modifications, and non-ignored untracked files, but not `.git` or ignored dependencies.
- Each ready parallel step receives a distinct workspace and cannot share mutable checkout state.
- A worker can modify, add, delete, and return binary or text files.
- Patches are combined in an isolated integration repository before the source is changed.
- Concurrent source modification or patch conflict leaves the source untouched.
- Successful integration removes remote workspaces; a failed run retains them and records their paths.
- Snapshot download uses authenticated TB4-first/Tailscale-fallback control URLs.
- OMP `nexus_run_task` E2E changes a disposable source repository through Z13 and MBP verification.
