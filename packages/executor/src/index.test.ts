import { describe, expect, it } from "vitest";
import type { NodeSpec, ToolCall } from "@nexus/protocol";
import { NodeClient } from "./index.js";

const node: NodeSpec = {
  id: "z13-strix-halo",
  baseUrl: "http://100.71.59.61:7790",
  platform: "linux-x64",
  memoryGb: 64,
  capabilities: ["exec"],
  reachability: "lan",
  tags: [],
  executionClass: 96,
  reliabilityClass: 90,
  models: [],
};
const call: ToolCall = {
  id: "test",
  name: "shell.exec",
  arguments: { argv: ["hostname"] },
};

describe("NodeClient route failover", () => {
  it("prefers TB4 and falls back to Tailscale before executing once", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === "http://169.254.77.2:7790/health")
        throw new TypeError("offline");
      if (url === "http://100.71.59.61:7790/health")
        return Response.json({ ok: true });
      return Response.json({
        toolCallId: "test",
        name: "shell.exec",
        ok: true,
        text: "z13",
        images: [],
      });
    };
    const client = new NodeClient(node, "token", {
      fetchImpl,
      routesJson: JSON.stringify({
        "z13-strix-halo": [
          "http://169.254.77.2:7790",
          "http://100.71.59.61:7790",
        ],
      }),
    });
    await expect(client.tool(call)).resolves.toMatchObject({
      ok: true,
      text: "z13",
    });
    expect(seen).toEqual([
      "http://169.254.77.2:7790/health",
      "http://100.71.59.61:7790/health",
      "http://100.71.59.61:7790/v1/tool/execute",
    ]);
  });

  it("does not retry a tool call after execution has started", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/health")) return Response.json({ ok: true });
      return new Response("lost response", { status: 502 });
    };
    const client = new NodeClient(node, "token", {
      fetchImpl,
      routesJson: JSON.stringify({
        "z13-strix-halo": [
          "http://169.254.77.2:7790",
          "http://100.71.59.61:7790",
        ],
      }),
    });
    await expect(client.tool(call)).rejects.toThrow("not retried");
    expect(seen).toEqual([
      "http://169.254.77.2:7790/health",
      "http://169.254.77.2:7790/v1/tool/execute",
    ]);
  });
});
