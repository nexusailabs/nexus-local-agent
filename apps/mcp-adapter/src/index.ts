#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { NexusClient, type RoutedToolResult } from "./client.js";

const CHARACTER_LIMIT = 50_000;
const token = process.env.NEXUS_SHARED_TOKEN ?? "";

function compact(result: RoutedToolResult): {
  nodeId: string;
  route: string;
  ok: boolean;
  text: string;
  data?: unknown;
  truncated: boolean;
} {
  const text = result.result.text ?? "";
  return {
    nodeId: result.nodeId,
    route: result.route,
    ok: result.result.ok,
    text: text.length > CHARACTER_LIMIT ? text.slice(-CHARACTER_LIMIT) : text,
    ...(result.result.data === undefined ? {} : { data: result.result.data }),
    truncated: text.length > CHARACTER_LIMIT,
  };
}

function response(result: RoutedToolResult) {
  const output = compact(result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
    isError: !output.ok,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `Nexus request failed: ${message}. Check nexus_list_nodes, then retry.`,
      },
    ],
    isError: true,
  };
}

function agentResponse(result: unknown) {
  const rendered = JSON.stringify(result);
  const text =
    rendered.length > CHARACTER_LIMIT
      ? rendered.slice(-CHARACTER_LIMIT)
      : rendered;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      result,
      truncated: rendered.length > CHARACTER_LIMIT,
    },
  };
}

function targetOptions(
  nodeId: string | undefined,
  timeoutMs?: number,
): { nodeId?: string; timeoutMs?: number } {
  return {
    ...(nodeId ? { nodeId } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function createServer(): McpServer {
  const client = new NexusClient(token);
  const server = new McpServer({ name: "nexus-mcp-server", version: "0.2.0" });
  const nodeId = z
    .string()
    .min(1)
    .optional()
    .describe("Target Nexus node ID. Defaults to mbp-m5-max.");

  server.registerTool(
    "nexus_list_nodes",
    {
      title: "List Nexus Nodes",
      description:
        "List MBP, Z13, and other registered Nexus nodes with current route, status, capabilities, and load. Use before selecting a non-default node.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const nodes = await client.listNodes();
        const output = nodes.map((entry) => ({
          id: entry.node.id,
          status: entry.status,
          route: entry.node.baseUrl,
          platform: entry.node.platform,
          capabilities: entry.node.capabilities,
          metrics: entry.metrics,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: { nodes: output },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_run_task",
    {
      title: "Run Task on Nexus Fabric",
      description:
        "Primary entrypoint for autonomous work. The MBP plans and verifies with Qwen Next while Nexus routes shell, code, build, test, browser, and container execution to the Z13 worker by default. Larger objectives become a dependency-aware parallel plan; tiny objectives remain one worker step to avoid split overhead.",
      inputSchema: z
        .object({
          objective: z.string().min(1).max(200_000),
          kind: z
            .enum([
              "plan",
              "code",
              "shell",
              "build",
              "test",
              "review",
              "research",
              "general",
            ])
            .default("general"),
          repo_path: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Optional repository path that must exist on the selected execution node.",
            ),
          max_attempts: z.number().int().min(1).max(4).default(2),
          timeout_ms: z
            .number()
            .int()
            .min(5_000)
            .max(3_600_000)
            .default(3_600_000),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ objective, kind, repo_path, max_attempts, timeout_ms }) => {
      try {
        return agentResponse(
          await client.runAgent(
            {
              objective,
              kind,
              ...(repo_path ? { repoPath: repo_path } : {}),
              maxAttempts: max_attempts,
              metadata: {
                entrypoint: "mcp",
                executionPolicy: "z13-worker-first",
              },
            },
            timeout_ms,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_exec",
    {
      title: "Execute on Nexus Node",
      description:
        "Execute one argv-style command on the MBP by default, or another named Nexus node. This calls the authenticated Nexus execution API; it does not open an SSH session or invoke a shell unless argv explicitly requests one.",
      inputSchema: z
        .object({
          argv: z
            .array(z.string())
            .min(1)
            .describe("Executable followed by arguments."),
          cwd: z
            .string()
            .min(1)
            .optional()
            .describe("Working directory on the target node."),
          timeout_ms: z
            .number()
            .int()
            .min(1)
            .max(3_600_000)
            .default(600_000)
            .describe("Execution timeout in milliseconds."),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ argv, cwd, timeout_ms, node_id }) => {
      try {
        return response(
          await client.executeTool(
            "shell.exec",
            { argv, ...(cwd ? { cwd } : {}), timeoutMs: timeout_ms },
            targetOptions(node_id, timeout_ms + 10_000),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_read_file",
    {
      title: "Read File on Nexus Node",
      description:
        "Read a UTF-8 text file from the MBP by default, or another named Nexus node. Output is capped to the newest 50,000 characters.",
      inputSchema: z
        .object({
          path: z.string().min(1).describe("Path on the target node."),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, node_id }) => {
      try {
        return response(
          await client.executeTool("fs.read", { path }, targetOptions(node_id)),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_write_file",
    {
      title: "Write File on Nexus Node",
      description:
        "Write complete UTF-8 file contents on the MBP by default, or another named Nexus node, creating parent directories when needed.",
      inputSchema: z
        .object({
          path: z.string().min(1).describe("Path on the target node."),
          content: z
            .string()
            .max(4_000_000)
            .describe("Complete replacement contents."),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, content, node_id }) => {
      try {
        return response(
          await client.executeTool(
            "fs.write",
            { path, content },
            targetOptions(node_id),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_git_status",
    {
      title: "Git Status on Nexus Node",
      description:
        "Return porcelain Git status for a repository on the MBP by default.",
      inputSchema: z
        .object({
          cwd: z
            .string()
            .min(1)
            .describe("Repository directory on the target node."),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ cwd, node_id }) => {
      try {
        return response(
          await client.executeTool(
            "git.status",
            { cwd },
            targetOptions(node_id),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_git_diff",
    {
      title: "Git Diff on Nexus Node",
      description:
        "Return a staged or unstaged Git diff from a repository on the MBP by default.",
      inputSchema: z
        .object({
          cwd: z
            .string()
            .min(1)
            .describe("Repository directory on the target node."),
          staged: z
            .boolean()
            .default(false)
            .describe("Return the staged diff."),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ cwd, staged, node_id }) => {
      try {
        return response(
          await client.executeTool(
            "git.diff",
            { cwd, staged },
            targetOptions(node_id),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_run_code",
    {
      title: "Run Code on Nexus Node",
      description:
        "Run a bounded Python, Node.js, Bash, Ruby, Go, or Rust snippet on the MBP by default. The target host executes it directly; this is not a sandbox.",
      inputSchema: z
        .object({
          language: z.enum(["python", "node", "bash", "ruby", "go", "rust"]),
          code: z.string().min(1).max(4_000_000),
          cwd: z.string().min(1).optional(),
          timeout_ms: z.number().int().min(1).max(3_600_000).default(600_000),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ language, code, cwd, timeout_ms, node_id }) => {
      try {
        return response(
          await client.executeTool(
            "code.run",
            { language, code, ...(cwd ? { cwd } : {}), timeoutMs: timeout_ms },
            targetOptions(node_id, timeout_ms + 10_000),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "nexus_read_document",
    {
      title: "Read Document on Nexus Node",
      description:
        "Extract text from a text, PDF, or office-like document on the MBP by default, subject to tools installed on that node.",
      inputSchema: z
        .object({
          path: z.string().min(1),
          max_bytes: z
            .number()
            .int()
            .min(1_000)
            .max(4_000_000)
            .default(200_000),
          node_id: nodeId,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, max_bytes, node_id }) => {
      try {
        return response(
          await client.executeTool(
            "document.read",
            { path, maxBytes: max_bytes },
            targetOptions(node_id),
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

void serveStdio(createServer);
