import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { nanoid } from 'nanoid';
import { NodeAdvertisement, NodeHeartbeat, TaskKind, ToolCall } from '@nexus/protocol';
import { routeExecution, routeInference } from '@nexus/router';
import { LocalModelClient, type ChatContent, type ChatMessage, type ModelToolCall, type ModelToolDefinition } from '@nexus/provider';
import { builtinTools } from '@nexus/tools';
import type { MemoryKind } from '@nexus/memory';
import { loadConfig } from './config.js';
import { NodeRegistry } from './registry.js';
import { TaskStore } from './store.js';
import { FabricRuntime } from './fabric.js';

const config = await loadConfig();
const stateDir = process.env.NEXUS_STATE_DIR ?? '.state';
const store = new TaskStore(stateDir);
const registry = new NodeRegistry(config.cluster.bootstrapNodes, config.cluster.heartbeatTtlMs);
const nodes = () => registry.live();
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
await app.register(cors, { origin: true });
await app.register(sensible);
const token = process.env.NEXUS_SHARED_TOKEN;
if (!token) throw new Error('NEXUS_SHARED_TOKEN is required');
const fabric = new FabricRuntime(nodes, token, store, stateDir);
const memoryKinds = new Set<MemoryKind>(['semantic','episodic','procedural','workspace','artifact']);

app.addHook('onRequest', async (req, reply) => { if (req.url === '/health') return; if (req.headers.authorization !== `Bearer ${token}`) return reply.unauthorized('invalid token'); });
app.get('/health', async () => { const all = registry.list(); return { ok:true, service:'nexus-local-agent-control-plane', controlNodeId:config.cluster.controlNodeId, nodes:{ total:all.length, online:all.filter((entry)=>entry.status==='online').length, stale:all.filter((entry)=>entry.status==='stale').length }, searchProviders:fabric.search.providers.map((provider)=>provider.name) }; });
app.post('/v1/nodes/register', async (req, reply) => reply.code(201).send(registry.register(NodeAdvertisement.parse(req.body))));
app.post('/v1/nodes/:id/heartbeat', async (req) => { const id=(req.params as{id:string}).id,heartbeat=NodeHeartbeat.parse({...(req.body as object),nodeId:id});try{return registry.heartbeat(heartbeat);}catch(error){throw app.httpErrors.notFound(String(error));} });
app.get('/v1/nodes', async (req) => registry.list((req.query as{includeStale?:string}).includeStale !== 'false'));
app.get('/v1/routes/:kind', async (req) => { const kind=TaskKind.parse((req.params as{kind:string}).kind),query=req.query as{mode?:'inference'|'execution'};return query.mode==='execution'?routeExecution(nodes(),kind):routeInference(nodes(),kind); });
app.get('/v1/tools', async () => builtinTools);
app.post('/v1/tools/control', async (req) => fabric.executeControlTool(ToolCall.parse(req.body)));
app.post('/v1/research', async (req) => { const body=req.body as{query?:string;maxRounds?:number;maxSources?:number};if(!body.query)throw app.httpErrors.badRequest('query required');return fabric.research.run(body.query,body.maxRounds??2,body.maxSources??12); });
app.get('/v1/memory/search', async (req) => { const query=req.query as{q?:string;namespace?:string;kind?:string;limit?:string};if(!query.q)throw app.httpErrors.badRequest('q required');const kind=query.kind&&memoryKinds.has(query.kind as MemoryKind)?query.kind as MemoryKind:undefined;return fabric.memory.search(query.q,{namespace:query.namespace,kind,limit:query.limit?Number(query.limit):10}); });
app.post('/v1/memory', async (req) => { const body=req.body as{kind:MemoryKind;namespace:string;content:string;importance?:number;metadata?:Record<string,unknown>};return fabric.memory.store(body); });
app.post('/v1/tasks', async (req, reply) => reply.code(201).send(await fabric.submit(req.body)));
app.post('/v1/agent/run', async (req, reply) => reply.code(201).send(await fabric.submit(req.body, true)));
app.get('/v1/tasks/:id', async (req) => { const result=store.get((req.params as{id:string}).id);if(!result.task)throw app.httpErrors.notFound('task not found');return result; });

app.get('/v1/models', async () => ({ object:'list', data:[{id:'nexus-auto',object:'model',owned_by:'nexus-local-agent'}] }));
function parseToolCalls(value: unknown): ModelToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ModelToolCall[] = [];
  for (const entry of value) {
    const call = entry as Record<string,unknown>;
    const fn = call.function && typeof call.function === 'object' ? call.function as Record<string,unknown> : {};
    const rawArguments = String(fn.arguments ?? '{}');
    let args: Record<string,unknown> = {};
    try { const parsed: unknown = JSON.parse(rawArguments); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string,unknown>; } catch {}
    calls.push({ id:String(call.id??nanoid()), name:String(fn.name??''), arguments:args, rawArguments });
  }
  return calls.length ? calls : undefined;
}
function normalizeContent(value: unknown): ChatContent {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return String(value ?? '');
  const output: Array<
    | { type:'text'; text:string }
    | { type:'image_url'; image_url:{ url:string; detail?:'low'|'high'|'auto'|undefined } }
  > = [];
  for (const part of value) {
    const item = part as Record<string,unknown>;
    if (item.type === 'text') {
      output.push({ type:'text', text:String(item.text??'') });
      continue;
    }
    if (item.type === 'image_url') {
      const raw = item.image_url;
      const image = raw && typeof raw === 'object' ? raw as Record<string,unknown> : {};
      const detail = image.detail === 'low' || image.detail === 'high' || image.detail === 'auto' ? image.detail : undefined;
      output.push({ type:'image_url', image_url:{ url:String(image.url??''), ...(detail ? { detail } : {}) } });
    }
  }
  return output;
}
function normalizeMessages(raw: unknown[]): ChatMessage[] {
  const output: ChatMessage[] = [];
  for (const value of raw) {
    const item = value as Record<string,unknown>;
    const role = item.role;
    if (role === 'tool') { output.push({ role:'tool', content:String(item.content??''), toolCallId:String(item.tool_call_id??'') }); continue; }
    if (role === 'assistant') { const calls=parseToolCalls(item.tool_calls); output.push({ role:'assistant', content:item.content===null?null:String(item.content??''), ...(calls ? {toolCalls:calls}: {}) }); continue; }
    if (role === 'user' || role === 'system') output.push({ role, content:normalizeContent(item.content) });
  }
  return output;
}
app.post('/v1/chat/completions', async (req) => {
  const body=req.body as{messages?:unknown[];max_tokens?:number;temperature?:number;reasoning_effort?:'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';tools?:Array<{type:'function';function:ModelToolDefinition}>};
  if(!body.messages?.length)throw app.httpErrors.badRequest('messages required');
  const live=nodes(),route=routeInference(live,'general'),node=live.find((candidate)=>candidate.id===route.nodeId),model=node?.models.find((candidate)=>candidate.id===route.modelId);
  if(!node||!model)throw app.httpErrors.serviceUnavailable('inference route disappeared');
  const turn=await new LocalModelClient(model).turn({ messages:normalizeMessages(body.messages), maxTokens:body.max_tokens, temperature:body.temperature, reasoningEffort:body.reasoning_effort, tools:body.tools?.filter((tool)=>tool.type==='function').map((tool)=>tool.function) });
  return{id:`chatcmpl_${nanoid()}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:'nexus-auto',nexus_route:{nodeId:node.id,modelId:model.id},choices:[{index:0,message:{role:'assistant',content:turn.content||null,...(turn.toolCalls.length?{tool_calls:turn.toolCalls.map((call)=>({id:call.id,type:'function',function:{name:call.name,arguments:call.rawArguments}}))}:{})},finish_reason:turn.toolCalls.length?'tool_calls':'stop'}]};
});

const bind=process.env.NEXUS_BIND??'0.0.0.0',port=Number(process.env.NEXUS_CONTROL_PORT??7788);await app.listen({host:bind,port});
