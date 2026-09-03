import Fastify from "fastify";
import sensible from "@fastify/sensible";
import os from "node:os";
import {
  ExecRequest,
  ModelSpec,
  NodeAdvertisement,
  NodeCapability,
  NodeHeartbeat,
  NodeSpec,
  ToolCall,
} from "@nexus/protocol";
import {
  ControlRouteRegistration,
  parseControlRoutes,
  type ControlRoute,
} from "./control-routes.js";
import { LocalToolRuntime } from "./local-tools.js";
import { runProcess } from "./process.js";

const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024 });
await app.register(sensible);

const token = process.env.NEXUS_SHARED_TOKEN;
if (!token) throw new Error("NEXUS_SHARED_TOKEN is required");

const bind = process.env.NEXUS_BIND ?? "0.0.0.0";
const port = Number(process.env.NEXUS_NODE_PORT ?? 7790);
const nodeId = process.env.NEXUS_NODE_ID ?? os.hostname();
const advertisedBaseUrl =
  process.env.NEXUS_NODE_BASE_URL ?? `http://127.0.0.1:${port}`;
const capabilities = (process.env.NEXUS_NODE_CAPABILITIES ?? "exec,fs")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => NodeCapability.parse(value));
const models = ModelSpec.array().parse(
  process.env.NEXUS_MODELS_JSON
    ? JSON.parse(process.env.NEXUS_MODELS_JSON)
    : [],
);
const PublicModelSpec = ModelSpec.omit({ apiKey: true });
const node = NodeSpec.parse({
  id: nodeId,
  baseUrl: advertisedBaseUrl,
  platform: `${process.platform}-${process.arch}`,
  memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
  capabilities,
  reachability: process.env.NEXUS_NODE_REACHABILITY ?? "lan",
  ...(process.env.NEXUS_REGION ? { region: process.env.NEXUS_REGION } : {}),
  tags: (process.env.NEXUS_NODE_TAGS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  executionClass: Number(process.env.NEXUS_EXECUTION_CLASS ?? 50),
  reliabilityClass: Number(process.env.NEXUS_RELIABILITY_CLASS ?? 90),
  models,
});
const tools = new LocalToolRuntime(node);
const controlRoutes = parseControlRoutes(process.env);
const registration = controlRoutes.length
  ? new ControlRouteRegistration(
      controlRoutes,
      token,
      fetch,
      Number(process.env.NEXUS_CONTROL_TIMEOUT_MS ?? 2_000),
    )
  : undefined;

let activeJobs = 0;
const metrics = () => ({
  freeMemoryBytes: os.freemem(),
  load1: Math.max(0, os.loadavg()[0] ?? 0),
  uptimeSeconds: os.uptime(),
  activeJobs,
});
const has = (capability: (typeof node.capabilities)[number]) =>
  node.capabilities.includes(capability);
const advertisedNode = (route?: ControlRoute) => ({
  ...node,
  ...(route ? { baseUrl: route.nodeBaseUrl } : {}),
});
const advertisementFor = (route: ControlRoute) =>
  NodeAdvertisement.parse({
    node: advertisedNode(route),
    metrics: metrics(),
    ts: new Date().toISOString(),
  });

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health") return;
  if (request.headers.authorization !== `Bearer ${token}`)
    return reply.unauthorized("invalid token");
});

app.get("/health", async () => ({
  ok: true,
  node: {
    ...advertisedNode(registration?.activeRoute),
    models: node.models.map((model) => PublicModelSpec.parse(model)),
  },
  registrationRoute: registration?.activeRoute?.name ?? null,
  metrics: metrics(),
  ts: new Date().toISOString(),
}));

app.post("/v1/exec", async (request) => {
  if (!has("exec"))
    throw app.httpErrors.forbidden("node does not advertise exec capability");
  const spec = ExecRequest.parse(request.body);
  activeJobs += 1;
  try {
    return await runProcess(spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      timeoutMs: spec.timeoutMs,
    });
  } finally {
    activeJobs -= 1;
  }
});

app.post("/v1/tool/execute", async (request) => {
  const call = ToolCall.parse(request.body);
  activeJobs += 1;
  try {
    return await tools.execute(call);
  } finally {
    activeJobs -= 1;
  }
});

app.post("/v1/fs/read", async (request) => {
  if (!has("fs"))
    throw app.httpErrors.forbidden("node does not advertise fs capability");
  const { readFile } = await import("node:fs/promises");
  const body = request.body as { path?: string };
  if (!body.path) throw app.httpErrors.badRequest("path required");
  return { path: body.path, content: await readFile(body.path, "utf8") };
});

async function register(): Promise<void> {
  if (!registration) return;
  const previous = registration.activeRoute;
  const route = await registration.register(advertisementFor);
  app.log.info(
    { nodeId, route: route.name, previousRoute: previous?.name ?? null },
    "registered with control plane",
  );
}

async function heartbeat(): Promise<void> {
  if (!registration) return;
  const previous = registration.activeRoute;
  const payload = NodeHeartbeat.parse({
    nodeId,
    metrics: metrics(),
    ts: new Date().toISOString(),
  });
  const route = await registration.heartbeat(
    `/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`,
    payload,
    advertisementFor,
  );
  if (route.name !== previous?.name) {
    app.log.info(
      { nodeId, route: route.name, previousRoute: previous?.name ?? null },
      "control route switched",
    );
  }
}

await app.listen({ host: bind, port });
if (registration) {
  register().catch((error) =>
    app.log.error({ err: error }, "initial registration failed"),
  );
  setInterval(
    () =>
      heartbeat().catch((error) =>
        app.log.warn({ err: error }, "heartbeat failed"),
      ),
    Number(process.env.NEXUS_HEARTBEAT_MS ?? 10_000),
  ).unref();
}

const shutdown = async () => {
  await tools.browser.closeAll();
  await app.close();
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
