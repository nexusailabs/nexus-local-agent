import type { ModelToolDefinition } from "@nexus/provider";
import type { NodeCapability, NodeSpec, TaskKind } from "@nexus/protocol";

export type ToolScope = "control" | "node";
export type ToolDescriptor = {
  name: string;
  description: string;
  scope: ToolScope;
  requiredCapabilities: NodeCapability[];
  parameters: Record<string, unknown>;
};
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
export const builtinTools: ToolDescriptor[] = [
  {
    name: "shell.exec",
    description: "Execute an argv command on the routed execution node.",
    scope: "node",
    requiredCapabilities: ["exec"],
    parameters: object(
      {
        argv: { type: "array", items: { type: "string" } },
        cwd: str("Working directory"),
        timeoutMs: num("Timeout in milliseconds"),
      },
      ["argv"],
    ),
  },
  {
    name: "fs.read",
    description: "Read a UTF-8 text file.",
    scope: "node",
    requiredCapabilities: ["fs"],
    parameters: object(
      { path: str("Absolute or working-directory-relative path") },
      ["path"],
    ),
  },
  {
    name: "fs.write",
    description: "Write a UTF-8 text file, creating parent directories.",
    scope: "node",
    requiredCapabilities: ["fs"],
    parameters: object(
      { path: str("File path"), content: str("Complete file contents") },
      ["path", "content"],
    ),
  },
  {
    name: "git.status",
    description: "Return porcelain Git status.",
    scope: "node",
    requiredCapabilities: ["git"],
    parameters: object({ cwd: str("Repository directory") }),
  },
  {
    name: "git.diff",
    description: "Return a Git diff.",
    scope: "node",
    requiredCapabilities: ["git"],
    parameters: object({
      cwd: str("Repository directory"),
      staged: bool("Use --cached"),
    }),
  },
  {
    name: "code.run",
    description:
      "Run a language snippet on the routed execution node using python, node, bash, ruby, go, or rust. The current backend is host execution, not a security sandbox.",
    scope: "node",
    requiredCapabilities: ["code"],
    parameters: object(
      {
        language: {
          type: "string",
          enum: ["python", "node", "bash", "ruby", "go", "rust"],
        },
        code: str("Source code"),
        cwd: str("Optional working directory"),
        timeoutMs: num("Timeout"),
      },
      ["language", "code"],
    ),
  },
  {
    name: "document.read",
    description:
      "Read a local text-like document. PDF uses pdftotext and office-like formats use pandoc when installed.",
    scope: "node",
    requiredCapabilities: ["documents"],
    parameters: object(
      { path: str("Document path"), maxBytes: num("Maximum bytes") },
      ["path"],
    ),
  },
  {
    name: "browser.open",
    description:
      "Create a Playwright Chromium session and optionally navigate.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object({
      sessionId: str("Optional stable session id"),
      url: str("Optional URL"),
      headless: bool("Run headless"),
    }),
  },
  {
    name: "browser.navigate",
    description: "Navigate a browser session.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object({ sessionId: str("Session id"), url: str("URL") }, [
      "sessionId",
      "url",
    ]),
  },
  {
    name: "browser.click",
    description: "Click by Playwright selector or pixel coordinates.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object(
      {
        sessionId: str("Session id"),
        selector: str("Playwright locator string"),
        x: num("X coordinate"),
        y: num("Y coordinate"),
      },
      ["sessionId"],
    ),
  },
  {
    name: "browser.type",
    description: "Fill a selector or type into the focused element.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object(
      {
        sessionId: str("Session id"),
        selector: str("Locator"),
        text: str("Text"),
      },
      ["sessionId", "text"],
    ),
  },
  {
    name: "browser.extract",
    description: "Extract visible text or HTML from a page/selector.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object(
      {
        sessionId: str("Session id"),
        selector: str("Locator"),
        mode: { type: "string", enum: ["text", "html"] },
      },
      ["sessionId"],
    ),
  },
  {
    name: "browser.screenshot",
    description: "Capture a browser screenshot for visual reasoning.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object(
      { sessionId: str("Session id"), fullPage: bool("Capture full page") },
      ["sessionId"],
    ),
  },
  {
    name: "browser.close",
    description: "Close a browser session.",
    scope: "node",
    requiredCapabilities: ["browser"],
    parameters: object({ sessionId: str("Session id") }, ["sessionId"]),
  },
  {
    name: "computer.screenshot",
    description: "Capture the physical desktop.",
    scope: "node",
    requiredCapabilities: ["computer"],
    parameters: object({}),
  },
  {
    name: "computer.click",
    description: "Click the physical desktop at coordinates.",
    scope: "node",
    requiredCapabilities: ["computer"],
    parameters: object(
      {
        x: num("X coordinate"),
        y: num("Y coordinate"),
        button: { type: "string", enum: ["left", "right"] },
      },
      ["x", "y"],
    ),
  },
  {
    name: "computer.type",
    description: "Type text into the focused desktop application.",
    scope: "node",
    requiredCapabilities: ["computer"],
    parameters: object({ text: str("Text to type") }, ["text"]),
  },
  {
    name: "computer.key",
    description: "Press a keyboard key or shortcut.",
    scope: "node",
    requiredCapabilities: ["computer"],
    parameters: object(
      { key: str("Key or shortcut such as ENTER, ESCAPE, CMD+L, CTRL+L") },
      ["key"],
    ),
  },
  {
    name: "computer.scroll",
    description: "Scroll the physical desktop.",
    scope: "node",
    requiredCapabilities: ["computer"],
    parameters: object(
      { deltaY: num("Positive scrolls down, negative scrolls up") },
      ["deltaY"],
    ),
  },
  {
    name: "computer.open_app",
    description: "Launch a desktop application.",
    scope: "node",
    requiredCapabilities: ["computer"],
    parameters: object({ name: str("Application name") }, ["name"]),
  },
  {
    name: "workspace.prepare",
    description:
      "Internal: create an isolated Git workspace from a control-plane snapshot.",
    scope: "node",
    requiredCapabilities: ["exec", "fs", "git"],
    parameters: object(
      {
        workspaceId: str("Unique workspace identifier"),
        archiveUrls: { type: "array", items: { type: "string" } },
        sha256: str("Expected archive SHA-256"),
      },
      ["workspaceId", "archiveUrls", "sha256"],
    ),
  },
  {
    name: "workspace.collect",
    description:
      "Internal: collect a binary Git patch from an isolated workspace.",
    scope: "node",
    requiredCapabilities: ["exec", "fs", "git"],
    parameters: object({ workspaceId: str("Workspace identifier") }, [
      "workspaceId",
    ]),
  },
  {
    name: "workspace.cleanup",
    description:
      "Internal: remove an isolated workspace after successful integration.",
    scope: "node",
    requiredCapabilities: ["exec", "fs", "git"],
    parameters: object({ workspaceId: str("Workspace identifier") }, [
      "workspaceId",
    ]),
  },
  {
    name: "web.search",
    description: "Search the public web through configured search providers.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object(
      { query: str("Search query"), limit: num("Maximum results") },
      ["query"],
    ),
  },
  {
    name: "web.fetch",
    description: "Fetch a URL and extract readable text.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object(
      {
        url: str("http/https URL"),
        maxChars: num("Maximum extracted characters"),
      },
      ["url"],
    ),
  },
  {
    name: "research.run",
    description:
      "Run multi-query, multi-round Deep Research with source fetching and citation validation.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object(
      {
        query: str("Research question"),
        maxRounds: num("Search rounds"),
        maxSources: num("Maximum sources"),
      },
      ["query"],
    ),
  },
  {
    name: "memory.search",
    description: "Search durable Nexus memory.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object(
      {
        query: str("Query"),
        namespace: str("Optional project namespace"),
        kind: str("Optional memory kind"),
        limit: num("Maximum matches"),
      },
      ["query"],
    ),
  },
  {
    name: "memory.store",
    description:
      "Store durable semantic, episodic, procedural, workspace, or artifact memory.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object(
      {
        kind: {
          type: "string",
          enum: ["semantic", "episodic", "procedural", "workspace", "artifact"],
        },
        namespace: str("Project namespace"),
        content: str("Memory content"),
        importance: num("0..100"),
        metadata: { type: "object", additionalProperties: true },
      },
      ["kind", "namespace", "content"],
    ),
  },
  {
    name: "agent.delegate",
    description: "Create and execute a verified child task on the fabric.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object(
      {
        objective: str("Child objective"),
        kind: str("Task kind"),
        repoPath: str("Repository path"),
        platform: str("Optional execution platform"),
        region: str("Optional region"),
      },
      ["objective"],
    ),
  },
  {
    name: "node.status",
    description:
      "Inspect live/stale cluster nodes, capabilities, metrics, and models.",
    scope: "control",
    requiredCapabilities: [],
    parameters: object({}),
  },
];
export function getTool(name: string): ToolDescriptor | undefined {
  return builtinTools.find((tool) => tool.name === name);
}
export function toModelTool(tool: ToolDescriptor): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
function hasAll(node: NodeSpec, caps: NodeCapability[]) {
  return caps.every((cap) => node.capabilities.includes(cap));
}
const namespacesByKind: Record<TaskKind, Set<string>> = {
  plan: new Set(["web", "memory", "node", "agent"]),
  code: new Set([
    "shell",
    "fs",
    "git",
    "code",
    "browser",
    "computer",
    "memory",
    "agent",
    "node",
    "document",
  ]),
  shell: new Set(["shell", "fs", "computer", "node"]),
  build: new Set(["shell", "fs", "git", "code", "memory", "agent", "node"]),
  test: new Set([
    "shell",
    "fs",
    "git",
    "code",
    "browser",
    "computer",
    "memory",
    "agent",
    "node",
  ]),
  review: new Set([
    "shell",
    "fs",
    "git",
    "code",
    "web",
    "browser",
    "computer",
    "memory",
    "research",
    "agent",
    "node",
    "document",
  ]),
  research: new Set([
    "web",
    "browser",
    "computer",
    "code",
    "memory",
    "research",
    "agent",
    "node",
    "document",
  ]),
  general: new Set([
    "shell",
    "fs",
    "git",
    "code",
    "web",
    "browser",
    "computer",
    "memory",
    "research",
    "agent",
    "node",
    "document",
  ]),
};
export function toolsForStep(
  kind: TaskKind,
  executionNode: NodeSpec,
): ToolDescriptor[] {
  const allowed = namespacesByKind[kind];
  return builtinTools.filter(
    (tool) =>
      allowed.has(tool.name.split(".")[0]!) &&
      (tool.scope === "control" ||
        hasAll(executionNode, tool.requiredCapabilities)),
  );
}
