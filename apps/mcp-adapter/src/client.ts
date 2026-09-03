import {
  RuntimeNode,
  ToolResult,
  type RuntimeNode as RuntimeNodeType,
  type ToolResult as ToolResultType,
} from "@nexus/protocol";

type Fetch = typeof fetch;
type RouteMap = Record<string, string[]>;

export interface RoutedToolResult {
  nodeId: string;
  route: string;
  result: ToolResultType;
}

const trimSlash = (value: string): string => value.replace(/\/$/, "");

function parseRouteMap(value: string | undefined): RouteMap {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NEXUS_NODE_ROUTES_JSON must be an object");
  }
  const routes: RouteMap = {};
  for (const [nodeId, candidates] of Object.entries(parsed)) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error(`NEXUS_NODE_ROUTES_JSON.${nodeId} must be a non-empty array`);
    }
    routes[nodeId] = candidates.map((candidate) => {
      if (typeof candidate !== "string") {
        throw new Error(`NEXUS_NODE_ROUTES_JSON.${nodeId} contains a non-string URL`);
      }
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`unsupported Nexus route protocol: ${url.protocol}`);
      }
      return trimSlash(url.toString());
    });
  }
  return routes;
}

export class NexusClient {
  private readonly controlUrl: string;
  private readonly defaultNodeId: string;
  private readonly routes: RouteMap;

  constructor(
    private readonly token: string,
    options: {
      controlUrl?: string;
      defaultNodeId?: string;
      routesJson?: string;
      fetchImpl?: Fetch;
    } = {},
  ) {
    if (!token) throw new Error("NEXUS_SHARED_TOKEN is required");
    this.controlUrl = trimSlash(
      options.controlUrl ?? process.env.NEXUS_CONTROL_URL ?? "http://127.0.0.1:7788",
    );
    this.defaultNodeId =
      options.defaultNodeId ?? process.env.NEXUS_DEFAULT_NODE_ID ?? "mbp-m5-max";
    this.routes = parseRouteMap(
      options.routesJson ?? process.env.NEXUS_NODE_ROUTES_JSON,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: Fetch;

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  async listNodes(): Promise<RuntimeNodeType[]> {
    const response = await this.fetchImpl(
      `${this.controlUrl}/v1/nodes?includeStale=true`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Nexus control plane returned HTTP ${response.status}`);
    }
    return RuntimeNode.array().parse(await response.json());
  }

  async executeTool(
    name: string,
    arguments_: Record<string, unknown>,
    options: { nodeId?: string; timeoutMs?: number } = {},
  ): Promise<RoutedToolResult> {
    const nodeId = options.nodeId ?? this.defaultNodeId;
    const node = (await this.listNodes()).find((entry) => entry.node.id === nodeId);
    if (!node) throw new Error(`Nexus node is not registered: ${nodeId}`);
    if (node.status !== "online") throw new Error(`Nexus node is stale: ${nodeId}`);

    const candidates = [node.node.baseUrl, ...(this.routes[nodeId] ?? [])]
      .map(trimSlash)
      .filter((value, index, all) => all.indexOf(value) === index);
    const failures: string[] = [];
    const timeoutMs = Math.min(3_610_000, Math.max(5_000, options.timeoutMs ?? 30_000));
    let selectedBaseUrl: string | undefined;
    for (const baseUrl of candidates) {
      try {
        const health = await this.fetchImpl(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (!health.ok) throw new Error(`health returned HTTP ${health.status}`);
        selectedBaseUrl = baseUrl;
        break;
      } catch (error) {
        failures.push(
          `${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!selectedBaseUrl) {
      throw new Error(
        `Nexus node ${nodeId} was unreachable on every private route (${failures.join("; ")})`,
      );
    }

    const response = await this.fetchImpl(`${selectedBaseUrl}/v1/tool/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        id: `mcp-${crypto.randomUUID()}`,
        name,
        arguments: arguments_,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Nexus node ${nodeId} returned HTTP ${response.status} on ${selectedBaseUrl}; the operation was not retried to avoid duplicate side effects`,
      );
    }
    return {
      nodeId,
      route: selectedBaseUrl,
      result: ToolResult.parse(await response.json()),
    };
  }
}
