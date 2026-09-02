# Native tool contract

Nexus tools are first-class JSON-schema function tools. MCP can be added as an adapter later, but the agent runtime does not depend on MCP.

## Scope model

- **control** tools execute inside the Air control plane and operate orchestration-owned services.
- **node** tools execute through `/v1/tool/execute` on a routed node daemon after capability checks.

The model sees only tools relevant to the current task kind and supported by the selected execution node.

| Tool | Scope | Required node capability | Current backend |
| --- | --- | --- | --- |
| `shell.exec` | node | `exec` | Node `spawn`, argv-first, timeout/output cap |
| `fs.read` | node | `fs` | native filesystem |
| `fs.write` | node | `fs` | native filesystem |
| `git.status` | node | `git` | Git CLI |
| `git.diff` | node | `git` | Git CLI |
| `code.run` | node | `code` | host python/node/bash/ruby/go/rust execution |
| `document.read` | node | `documents` | text + optional `pdftotext`/`pandoc` |
| `browser.open` | node | `browser` | Playwright Chromium session |
| `browser.navigate` | node | `browser` | Playwright |
| `browser.click` | node | `browser` | Playwright selector or coordinates |
| `browser.type` | node | `browser` | Playwright fill/keyboard |
| `browser.extract` | node | `browser` | visible text / HTML |
| `browser.screenshot` | node | `browser` | PNG -> `ToolResult.images` |
| `browser.close` | node | `browser` | Playwright session cleanup |
| `computer.screenshot` | node | `computer` | macOS/Linux desktop capture |
| `computer.click` | node | `computer` | CoreGraphics or Linux input backend |
| `computer.type` | node | `computer` | System Events / `wtype` / `xdotool` |
| `computer.key` | node | `computer` | System Events / `xdotool` |
| `computer.scroll` | node | `computer` | CoreGraphics / `xdotool` |
| `computer.open_app` | node | `computer` | `open -a` / `gtk-launch` |
| `web.search` | control | none | SearXNG/Brave/Tavily/Exa broker |
| `web.fetch` | control | none | HTTP fetch + readable HTML extraction |
| `research.run` | control | none | multi-round Deep Research workflow |
| `memory.search` | control | none | SQLite FTS5 / LIKE fallback |
| `memory.store` | control | none | SQLite WAL |
| `agent.delegate` | control | none | verified child task lifecycle |
| `node.status` | control | none | live registry snapshot |

## Visual feedback contract

A screenshot tool returns both compact textual metadata and an image:

```text
ToolResult
  text: session/url/status metadata
  images:
    - mimeType: image/png
      dataBase64: ...
```

The executor appends the image to the next model turn as a high-detail `image_url` data URI. A multimodal model can therefore inspect the visual result and issue the next action without a separate computer-use model.

## Browser operating rule

Prefer this order:

1. `browser.extract` / deterministic state inspection;
2. selector-based `browser.click` / `browser.type`;
3. browser screenshot + vision grounding;
4. physical `computer.*` only when browser DOM access is insufficient or the target is a native application.

## Computer-use host prerequisites

### macOS

- Screen Recording permission for screenshots.
- Accessibility permission for keyboard/mouse automation.
- Xcode Command Line Tools/Swift available for the CoreGraphics pointer/scroll adapter.

### Linux

- screenshot: `grim` preferred on compatible Wayland sessions, otherwise `gnome-screenshot`;
- typing: `wtype` when available, otherwise `xdotool`;
- click/key/scroll: currently `xdotool`.

The Linux adapter should be generalized to `uinput`/`ydotool` for Wayland-native deployments in a later change.

## Code execution boundary

`code.run` is deliberately described truthfully: it currently runs on the selected host and is **not a security sandbox**. Go and Rust use a temporary build directory; interpreted languages execute directly. If container/microVM isolation is added later, keep the same tool contract and change the backend/policy.

## Deep Research guarantees

`research.run` guarantees structural source accounting, not omniscience:

- every executed search query is returned;
- source URLs are normalized and deduplicated;
- complete provider failure is surfaced;
- synthesis source IDs are assigned deterministically (`S1`, `S2`, ...);
- citation IDs in the report are audited;
- one citation repair pass is attempted;
- output with no valid citation or invented source IDs fails.

It cannot prove that every sentence is semantically supported by a cited source. Stronger entailment checking is a future verifier layer.
