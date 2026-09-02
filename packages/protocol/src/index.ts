import { z } from 'zod';

export const NodeCapability = z.enum([
  'control', 'control-standby', 'inference', 'exec', 'fs', 'git', 'containers',
  'browser', 'computer', 'code', 'documents', 'ci', 'network-probe', 'long-running'
]);
export type NodeCapability = z.infer<typeof NodeCapability>;

export const NodePlatform = z.enum(['darwin-arm64', 'linux-x64']);
export type NodePlatform = z.infer<typeof NodePlatform>;
export const NodeReachability = z.enum(['local', 'lan', 'wan']);
export type NodeReachability = z.infer<typeof NodeReachability>;

export const ModelCapability = z.enum([
  'reasoning', 'coding', 'tool-use', 'vision', 'long-context', 'fast-draft', 'review'
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const ModelSpec = z.object({
  id: z.string().min(1),
  provider: z.enum(['openai-compatible', 'omlx', 'mlx-serve', 'llama.cpp']),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().default(16384),
  capabilities: z.array(ModelCapability),
  costClass: z.number().int().min(0).max(100).default(50),
  speedClass: z.number().int().min(0).max(100).default(50),
  qualityClass: z.number().int().min(0).max(100).default(50)
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const NodeSpec = z.object({
  id: z.string().min(1), baseUrl: z.string().url(), platform: NodePlatform,
  memoryGb: z.number().positive(), capabilities: z.array(NodeCapability).default([]),
  reachability: NodeReachability.default('lan'), region: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]), executionClass: z.number().int().min(0).max(100).default(50),
  reliabilityClass: z.number().int().min(0).max(100).default(80), models: z.array(ModelSpec).default([])
});
export type NodeSpec = z.infer<typeof NodeSpec>;

export const NodeMetrics = z.object({
  freeMemoryBytes: z.number().nonnegative().optional(), load1: z.number().nonnegative().optional(),
  uptimeSeconds: z.number().nonnegative().optional(), activeJobs: z.number().int().nonnegative().optional()
});
export type NodeMetrics = z.infer<typeof NodeMetrics>;
export const NodeAdvertisement = z.object({ node: NodeSpec, metrics: NodeMetrics.default({}), ts: z.string().datetime().optional() });
export type NodeAdvertisement = z.infer<typeof NodeAdvertisement>;
export const NodeHeartbeat = z.object({ nodeId: z.string().min(1), metrics: NodeMetrics.default({}), ts: z.string().datetime().optional() });
export type NodeHeartbeat = z.infer<typeof NodeHeartbeat>;
export const RuntimeNode = z.object({
  node: NodeSpec, metrics: NodeMetrics.default({}), source: z.enum(['dynamic', 'bootstrap']),
  status: z.enum(['online', 'stale']), lastSeenAt: z.string().datetime()
});
export type RuntimeNode = z.infer<typeof RuntimeNode>;

export const TaskKind = z.enum(['plan', 'code', 'shell', 'build', 'test', 'review', 'research', 'general']);
export type TaskKind = z.infer<typeof TaskKind>;
export const TaskStatus = z.enum(['queued', 'planning', 'running', 'verifying', 'repairing', 'succeeded', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const ExecutionRequirements = z.object({
  requiredCapabilities: z.array(NodeCapability).default([]), preferredCapabilities: z.array(NodeCapability).default([]),
  platform: NodePlatform.optional(), region: z.string().min(1).optional(), avoidNodes: z.array(z.string()).default([])
});
export type ExecutionRequirements = z.infer<typeof ExecutionRequirements>;
export const AgentTask = z.object({
  id: z.string().min(1), objective: z.string().min(1), repoPath: z.string().optional(),
  kind: TaskKind.default('general'), status: TaskStatus.default('queued'),
  maxAttempts: z.number().int().min(1).max(20).default(4), metadata: z.record(z.string(), z.unknown()).default({})
});
export type AgentTask = z.infer<typeof AgentTask>;

export const ExecRequest = z.object({
  argv: z.array(z.string()).min(1), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000)
});
export type ExecRequest = z.infer<typeof ExecRequest>;
export const ExecResult = z.object({
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string(), stderr: z.string(), durationMs: z.number().nonnegative()
});
export type ExecResult = z.infer<typeof ExecResult>;

export const ToolCall = z.object({
  id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({})
});
export type ToolCall = z.infer<typeof ToolCall>;
export const ToolImage = z.object({ mimeType: z.string().min(1), dataBase64: z.string().min(1) });
export type ToolImage = z.infer<typeof ToolImage>;
export const ToolResult = z.object({
  toolCallId: z.string().min(1), name: z.string().min(1), ok: z.boolean(), text: z.string().default(''),
  data: z.unknown().optional(), images: z.array(ToolImage).default([])
});
export type ToolResult = z.infer<typeof ToolResult>;

export const PlanStep = z.object({
  id: z.string(), title: z.string(), description: z.string(), kind: TaskKind,
  acceptance: z.array(z.string()).default([]), dependsOn: z.array(z.string()).default([]),
  execution: ExecutionRequirements.default({ requiredCapabilities: [], preferredCapabilities: [], avoidNodes: [] })
});
export type PlanStep = z.infer<typeof PlanStep>;
export const AgentPlan = z.object({ summary: z.string(), steps: z.array(PlanStep).min(1), globalAcceptance: z.array(z.string()).default([]) });
export type AgentPlan = z.infer<typeof AgentPlan>;
