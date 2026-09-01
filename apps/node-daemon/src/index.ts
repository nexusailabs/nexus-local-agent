import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  ExecRequest,
  ModelSpec,
  NodeAdvertisement,
  NodeCapability,
  NodeHeartbeat,
  NodeSpec
} from '@nexus/protocol';

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
await app.register(sensible);

const token = process.env.NEXUS_SHARED_TOKEN;
if (!token) throw new Error('NEXUS_SHARED_TOKEN is required');

const bind = process.env.NEXUS_BIND ?? '0.0.0.0';
const port = Number(process.env.NEXUS_NODE_PORT ?? 7790);
const nodeId = process.env.NEXUS_NODE_ID ?? os.hostname();
const advertisedBaseUrl = process.env.NEXUS_NODE_BASE_URL ?? `http://127.0.0.1:${port}`;
const capabilities = (process.env.NEXUS_NODE_CAPABILITIES ?? 'exec,fs')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => NodeCapability.parse(value));

const models = ModelSpec.array().parse(
  process.env.NEXUS_MODELS_JSON ? JSON.parse(process.env.NEXUS_MODELS_JSON) : []
);

const node = NodeSpec.parse({
  id: nodeId,
  baseUrl: advertisedBaseUrl,
  platform: `${process.platform}-${process.arch}`,
  memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
  capabilities,
  reachability: process.env.NEXUS_NODE_REACHABILITY ?? 'lan',
  ...(process.env.NEXUS_REGION ? { region: process.env.NEXUS_REGION } : {}),
  tags: (process.env.NEXUS_NODE_TAGS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  executionClass: Number(process.env.NEXUS_EXECUTION_CLASS ?? 50),
  reliabilityClass: Number(process.env.NEXUS_RELIABILITY_CLASS ?? 90),
  models
});

function metrics() {
  return {
    freeMemoryBytes: os.freemem(),
    load1: Math.max(0, os.loadavg()[0] ?? 0),
    uptimeSeconds: os.uptime()
  };
}

function hasCapability(capability: (typeof node.capabilities)[number]): boolean {
  return node.capabilities.includes(capability);
}

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.headers.authorization !== `Bearer ${token}`) return reply.unauthorized('invalid token');
});

app.get('/health', async () => ({
  ok: true,
  node,
  metrics: metrics(),
  ts: new Date().toISOString()
}));

app.post('/v1/exec', async (req) => {
  if (!hasCapability('exec')) throw app.httpErrors.forbidden('node does not advertise exec capability');
  const spec = ExecRequest.parse(req.body);
  const started = performance.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), spec.timeoutMs);
    child.stdout.on('data', (data) => (stdout += data.toString()));
    child.stderr.on('data', (data) => (stderr += data.toString()));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started)
      });
    });
  });
});

app.post('/v1/fs/read', async (req) => {
  if (!hasCapability('fs')) throw app.httpErrors.forbidden('node does not advertise fs capability');
  const { readFile } = await import('node:fs/promises');
  const body = req.body as { path?: string };
  if (!body.path) throw app.httpErrors.badRequest('path required');
  return { path: body.path, content: await readFile(body.path, 'utf8') };
});

async function postControl(path: string, body: unknown): Promise<Response> {
  const controlUrl = process.env.NEXUS_CONTROL_URL;
  if (!controlUrl) throw new Error('NEXUS_CONTROL_URL is not configured');
  return fetch(`${controlUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function register(): Promise<void> {
  if (!process.env.NEXUS_CONTROL_URL) return;
  if (!process.env.NEXUS_NODE_BASE_URL) {
    throw new Error('NEXUS_NODE_BASE_URL is required when registering with a remote control plane');
  }

  const advertisement = NodeAdvertisement.parse({ node, metrics: metrics(), ts: new Date().toISOString() });
  const response = await postControl('/v1/nodes/register', advertisement);
  if (!response.ok) throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  app.log.info({ nodeId }, 'registered with control plane');
}

async function heartbeat(): Promise<void> {
  if (!process.env.NEXUS_CONTROL_URL) return;
  const payload = NodeHeartbeat.parse({ nodeId, metrics: metrics(), ts: new Date().toISOString() });
  const response = await postControl(`/v1/nodes/${encodeURIComponent(nodeId)}/heartbeat`, payload);
  if (response.status === 404) {
    await register();
    return;
  }
  if (!response.ok) throw new Error(`heartbeat failed: ${response.status} ${await response.text()}`);
}

await app.listen({ host: bind, port });

if (process.env.NEXUS_CONTROL_URL) {
  register().catch((error) => app.log.error({ err: error }, 'initial registration failed'));
  const heartbeatMs = Number(process.env.NEXUS_HEARTBEAT_MS ?? 10_000);
  setInterval(() => {
    heartbeat().catch((error) => app.log.warn({ err: error }, 'heartbeat failed'));
  }, heartbeatMs).unref();
}
