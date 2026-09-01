import { z } from 'zod';

export const NodeRole = z.enum(['brain', 'worker', 'hybrid']);
export type NodeRole = z.infer<typeof NodeRole>;

export const ModelCapability = z.enum([
  'reasoning', 'coding', 'tool-use', 'vision', 'long-context', 'fast-draft', 'review'
]);

export const ModelSpec = z.object({
  id: z.string().min(1),
  provider: z.enum(['openai-compatible', 'omlx', 'llama.cpp']),
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
  id: z.string().min(1),
  role: NodeRole,
  baseUrl: z.string().url(),
  platform: z.enum(['darwin-arm64', 'linux-x64']),
  memoryGb: z.number().positive(),
  tags: z.array(z.string()).default([]),
  models: z.array(ModelSpec).default([])
});
export type NodeSpec = z.infer<typeof NodeSpec>;

export const TaskKind = z.enum([
  'plan', 'code', 'shell', 'build', 'test', 'review', 'research', 'general'
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskStatus = z.enum([
  'queued', 'planning', 'running', 'verifying', 'repairing', 'succeeded', 'failed', 'cancelled'
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const AgentTask = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  repoPath: z.string().optional(),
  kind: TaskKind.default('general'),
  status: TaskStatus.default('queued'),
  maxAttempts: z.number().int().min(1).max(20).default(4),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type AgentTask = z.infer<typeof AgentTask>;

export const ExecRequest = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000)
});
export type ExecRequest = z.infer<typeof ExecRequest>;

export const ExecResult = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative()
});
export type ExecResult = z.infer<typeof ExecResult>;

export const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: TaskKind,
  acceptance: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([])
});
export type PlanStep = z.infer<typeof PlanStep>;

export const AgentPlan = z.object({
  summary: z.string(),
  steps: z.array(PlanStep).min(1),
  globalAcceptance: z.array(z.string()).default([])
});
export type AgentPlan = z.infer<typeof AgentPlan>;
