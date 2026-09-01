import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { ExecRequest } from '@nexus/protocol';

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
await app.register(sensible);

const token = process.env.NEXUS_SHARED_TOKEN;
if (!token) throw new Error('NEXUS_SHARED_TOKEN is required');

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.headers.authorization !== `Bearer ${token}`) return reply.unauthorized('invalid token');
});

app.get('/health', async () => ({
  ok: true,
  nodeId: process.env.NEXUS_NODE_ID ?? os.hostname(),
  role: process.env.NEXUS_NODE_ROLE ?? 'hybrid',
  platform: `${process.platform}-${process.arch}`,
  memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
  loadavg: os.loadavg(),
  uptimeSeconds: os.uptime(),
  ts: new Date().toISOString()
}));

app.post('/v1/exec', async (req) => {
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
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, durationMs: Math.round(performance.now() - started) });
    });
  });
});

app.post('/v1/fs/read', async (req) => {
  const { readFile } = await import('node:fs/promises');
  const body = req.body as { path?: string };
  if (!body.path) throw app.httpErrors.badRequest('path required');
  return { path: body.path, content: await readFile(body.path, 'utf8') };
});

const bind = process.env.NEXUS_BIND ?? '0.0.0.0';
const port = Number(process.env.NEXUS_NODE_PORT ?? 7790);
await app.listen({ host: bind, port });
