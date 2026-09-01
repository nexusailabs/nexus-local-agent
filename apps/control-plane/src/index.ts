import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { nanoid } from 'nanoid';
import { AgentTask, NodeAdvertisement, NodeHeartbeat, TaskKind } from '@nexus/protocol';
import { routeExecution, routeInference } from '@nexus/router';
import { Orchestrator } from '@nexus/orchestrator';
import { LocalModelClient } from '@nexus/provider';
import { StepExecutor } from '@nexus/executor';
import { loadConfig } from './config.js';
import { NodeRegistry } from './registry.js';
import { TaskStore } from './store.js';

const config = await loadConfig();
const store = new TaskStore(process.env.NEXUS_STATE_DIR ?? '.state');
const registry = new NodeRegistry(config.cluster.bootstrapNodes, config.cluster.heartbeatTtlMs);
const nodes = () => registry.live();
const orchestrator = new Orchestrator(nodes);
const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(sensible);

const token = process.env.NEXUS_SHARED_TOKEN;
if (!token) throw new Error('NEXUS_SHARED_TOKEN is required');
const executor = new StepExecutor(nodes, token);

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.headers.authorization !== `Bearer ${token}`) return reply.unauthorized('invalid token');
});

app.get('/health', async () => {
  const all = registry.list();
  return {
    ok: true,
    service: 'nexus-local-agent-control-plane',
    controlNodeId: config.cluster.controlNodeId,
    nodes: {
      total: all.length,
      online: all.filter((entry) => entry.status === 'online').length,
      stale: all.filter((entry) => entry.status === 'stale').length
    }
  };
});

app.post('/v1/nodes/register', async (req, reply) => {
  const advertisement = NodeAdvertisement.parse(req.body);
  const runtime = registry.register(advertisement);
  return reply.code(201).send(runtime);
});

app.post('/v1/nodes/:id/heartbeat', async (req) => {
  const id = (req.params as { id: string }).id;
  const heartbeat = NodeHeartbeat.parse({ ...(req.body as object), nodeId: id });
  try {
    return registry.heartbeat(heartbeat);
  } catch (error) {
    throw app.httpErrors.notFound(String(error));
  }
});

app.get('/v1/nodes', async (req) => {
  const includeStale = (req.query as { includeStale?: string }).includeStale !== 'false';
  return registry.list(includeStale);
});

app.get('/v1/routes/:kind', async (req) => {
  const kind = TaskKind.parse((req.params as { kind: string }).kind);
  const query = req.query as { mode?: 'inference' | 'execution' };
  return query.mode === 'execution'
    ? routeExecution(nodes(), kind)
    : routeInference(nodes(), kind);
});

app.post('/v1/tasks', async (req, reply) => {
  const task = AgentTask.parse({ id: nanoid(), ...(req.body as object), status: 'queued' });
  store.put(task);
  store.setStatus(task.id, 'planning');

  try {
    const plan = await orchestrator.plan(task);
    store.event(task.id, 'plan.created', plan);
    const execute = Boolean((req.body as { execute?: boolean }).execute);

    if (!execute) {
      store.setStatus(task.id, 'running');
      return reply.code(201).send({ task, plan, executed: false });
    }

    store.setStatus(task.id, 'running');
    const stepResults = [];
    for (const step of plan.steps) {
      store.event(task.id, 'step.started', { stepId: step.id, title: step.title });
      const result = await executor.execute(task, step, task.repoPath);
      stepResults.push({ step, result });
      store.event(task.id, 'step.completed', { stepId: step.id, result });
    }

    store.setStatus(task.id, 'verifying');
    const verification = await orchestrator.verify(task, plan, JSON.stringify(stepResults));
    store.event(task.id, 'verification.completed', verification);
    store.setStatus(task.id, verification.pass ? 'succeeded' : 'failed', verification);
    return reply.code(201).send({ task, plan, executed: true, stepResults, verification });
  } catch (error) {
    store.setStatus(task.id, 'failed', { error: String(error) });
    throw error;
  }
});

app.get('/v1/tasks/:id', async (req) => {
  const result = store.get((req.params as { id: string }).id);
  if (!result.task) throw app.httpErrors.notFound('task not found');
  return result;
});

// OpenAI-compatible gateway: external clients can treat the live fabric as one model.
app.get('/v1/models', async () => ({
  object: 'list',
  data: [{ id: 'nexus-auto', object: 'model', owned_by: 'nexus-local-agent' }]
}));

app.post('/v1/chat/completions', async (req) => {
  const body = req.body as {
    messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_tokens?: number;
    temperature?: number;
  };
  if (!body.messages?.length) throw app.httpErrors.badRequest('messages required');

  const liveNodes = nodes();
  const route = routeInference(liveNodes, 'general');
  const node = liveNodes.find((candidate) => candidate.id === route.nodeId);
  const model = node?.models.find((candidate) => candidate.id === route.modelId);
  if (!node || !model) throw app.httpErrors.serviceUnavailable('inference route disappeared');

  const chatInput: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    temperature?: number;
  } = { messages: body.messages };
  if (body.max_tokens !== undefined) chatInput.maxTokens = body.max_tokens;
  if (body.temperature !== undefined) chatInput.temperature = body.temperature;

  const content = await new LocalModelClient(model).complete(chatInput);
  return {
    id: `chatcmpl_${nanoid()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'nexus-auto',
    nexus_route: { nodeId: node.id, modelId: model.id },
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  };
});

const bind = process.env.NEXUS_BIND ?? '0.0.0.0';
const port = Number(process.env.NEXUS_CONTROL_PORT ?? 7788);
await app.listen({ host: bind, port });
