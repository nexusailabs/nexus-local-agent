import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { nanoid } from 'nanoid';
import { AgentTask } from '@nexus/protocol';
import { routeTask } from '@nexus/router';
import { Orchestrator } from '@nexus/orchestrator';
import { LocalModelClient } from '@nexus/provider';
import { StepExecutor } from '@nexus/executor';
import { loadConfig } from './config.js';
import { TaskStore } from './store.js';

const config = await loadConfig();
const store = new TaskStore(process.env.NEXUS_STATE_DIR ?? '.state');
const orchestrator = new Orchestrator(config.nodes);
const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(sensible);

const token = process.env.NEXUS_SHARED_TOKEN;
if (!token) throw new Error('NEXUS_SHARED_TOKEN is required');
const executor = new StepExecutor(config.nodes, token);
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.headers.authorization !== `Bearer ${token}`) return reply.unauthorized('invalid token');
});

app.get('/health', async () => ({ ok: true, service: 'nexus-local-agent-control-plane', nodes: config.nodes.map(n => n.id) }));
app.get('/v1/nodes', async () => config.nodes);
app.get('/v1/routes/:kind', async (req) => routeTask(config.nodes, (req.params as {kind:string}).kind as never));

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
  const result = store.get((req.params as {id:string}).id);
  if (!result.task) throw app.httpErrors.notFound('task not found');
  return result;
});

// OpenAI-compatible gateway: external clients can treat the whole cluster as one model.
app.get('/v1/models', async () => ({
  object: 'list',
  data: [{ id: 'nexus-auto', object: 'model', owned_by: 'nexus-local-agent' }]
}));

app.post('/v1/chat/completions', async (req) => {
  const body = req.body as { messages?: Array<{role:'system'|'user'|'assistant'; content:string}>; max_tokens?: number; temperature?: number };
  if (!body.messages?.length) throw app.httpErrors.badRequest('messages required');
  const route = routeTask(config.nodes, 'general');
  const node = config.nodes.find(n => n.id === route.nodeId)!;
  const model = node.models.find(m => m.id === route.modelId)!;
  const chatInput: {
    messages: Array<{role:'system'|'user'|'assistant'; content:string}>;
    maxTokens?: number;
    temperature?: number;
  } = { messages: body.messages };
  if (body.max_tokens !== undefined) chatInput.maxTokens = body.max_tokens;
  if (body.temperature !== undefined) chatInput.temperature = body.temperature;
  const content = await new LocalModelClient(model).complete(chatInput);
  return {
    id: `chatcmpl_${nanoid()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'nexus-auto',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  };
});

const bind = process.env.NEXUS_BIND ?? '0.0.0.0';
const port = Number(process.env.NEXUS_CONTROL_PORT ?? 7788);
await app.listen({ host: bind, port });
