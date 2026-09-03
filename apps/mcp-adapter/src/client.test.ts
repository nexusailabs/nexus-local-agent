import { describe, expect, it } from "vitest";
import { NexusClient } from "./client.js";

const node = {
  node: {
    id: "mbp-m5-max",
    baseUrl: "http://169.254.77.1:7790",
    platform: "darwin-arm64",
    memoryGb: 128,
    capabilities: ["exec", "fs"],
    reachability: "lan",
    tags: [],
    executionClass: 10,
    reliabilityClass: 95,
    models: [],
  },
  metrics: {},
  source: "dynamic",
  status: "online",
  lastSeenAt: "2026-09-03T00:00:00.000Z",
};

describe("NexusClient", () => {
  it("falls back from TB4 to Tailscale", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/v1/nodes")) return Response.json([node]);
      if (url === "http://169.254.77.1:7790/health")
        throw new TypeError("offline");
      if (url === "http://100.107.237.37:7790/health") {
        return Response.json({ ok: true });
      }
      expect(init?.headers).toMatchObject({
        authorization: "Bearer test-token",
      });
      return Response.json({
        toolCallId: "test",
        name: "shell.exec",
        ok: true,
        text: "mbp-ok",
        images: [],
      });
    };
    const client = new NexusClient("test-token", {
      fetchImpl,
      routesJson: JSON.stringify({
        "mbp-m5-max": [
          "http://169.254.77.1:7790",
          "http://100.107.237.37:7790",
        ],
      }),
    });

    const result = await client.executeTool("shell.exec", {
      argv: ["hostname"],
    });

    expect(result.route).toBe("http://100.107.237.37:7790");
    expect(result.result.text).toBe("mbp-ok");
    expect(seen).toEqual([
      "http://127.0.0.1:7788/v1/nodes?includeStale=true",
      "http://169.254.77.1:7790/health",
      "http://100.107.237.37:7790/health",
      "http://100.107.237.37:7790/v1/tool/execute",
    ]);
  });

  it("refuses an unregistered target", async () => {
    const fetchImpl: typeof fetch = async () => Response.json([node]);
    const client = new NexusClient("test-token", { fetchImpl });
    await expect(
      client.executeTool(
        "shell.exec",
        { argv: ["hostname"] },
        { nodeId: "missing" },
      ),
    ).rejects.toThrow("not registered");
  });

  it("runs an objective through the planner-executor-verifier fabric", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:7788/v1/agent/run");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer test-token",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        objective: "inspect both nodes",
        kind: "general",
      });
      return Response.json({
        executed: true,
        attempts: 1,
        stepResults: [
          { result: { routing: { executionNodeId: "z13-strix-halo" } } },
        ],
        verification: { pass: true, findings: "PASS" },
      });
    };
    const client = new NexusClient("test-token", { fetchImpl });

    const result = await client.runAgent({
      objective: "inspect both nodes",
      kind: "general",
    });

    expect(result).toMatchObject({
      executed: true,
      verification: { pass: true },
    });
  });

  it("does not duplicate a tool call when the selected route returns an error", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/v1/nodes")) return Response.json([node]);
      if (url.endsWith("/health")) return Response.json({ ok: true });
      return new Response("lost response", { status: 502 });
    };
    const client = new NexusClient("test-token", {
      fetchImpl,
      routesJson: JSON.stringify({
        "mbp-m5-max": ["http://100.107.237.37:7790"],
      }),
    });

    await expect(
      client.executeTool("shell.exec", { argv: ["hostname"] }),
    ).rejects.toThrow("not retried to avoid duplicate side effects");
    expect(seen).toEqual([
      "http://127.0.0.1:7788/v1/nodes?includeStale=true",
      "http://169.254.77.1:7790/health",
      "http://169.254.77.1:7790/v1/tool/execute",
    ]);
  });
});
