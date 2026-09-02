import { nanoid } from 'nanoid';
import { AgentTask, TaskKind, type AgentPlan, type AgentTask as AgentTaskType, type NodeSpec, type PlanStep, type ToolCall, type ToolResult } from '@nexus/protocol';
import { Orchestrator } from '@nexus/orchestrator';
import { StepExecutor } from '@nexus/executor';
import { createSearchBrokerFromEnv, DeepResearchService, fetchDocument } from '@nexus/research';
import { MemoryStore, type MemoryKind } from '@nexus/memory';
import { getTool } from '@nexus/tools';
import type { TaskStore } from './store.js';

export type NodeSource = () => NodeSpec[];
export type RunResult = { task: AgentTaskType; plan: AgentPlan; executed: boolean; attempts: number; stepResults?: unknown[] | undefined; verification?: { pass: boolean; findings: string } | undefined };
const memoryKinds = new Set<MemoryKind>(['semantic','episodic','procedural','workspace','artifact']);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback='') => typeof value === 'string' ? value : fallback;
const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export class FabricRuntime {
  readonly memory: MemoryStore;
  readonly research: DeepResearchService;
  readonly search = createSearchBrokerFromEnv();
  private readonly orchestrator: Orchestrator;
  private readonly executor: StepExecutor;
  private readonly parallelism = Math.max(1, Number(process.env.NEXUS_TASK_PARALLELISM ?? 3));

  constructor(private readonly nodes: NodeSource, private readonly token: string, private readonly store: TaskStore, stateDir: string) {
    this.memory = new MemoryStore(stateDir);
    this.research = new DeepResearchService(nodes, this.search);
    this.orchestrator = new Orchestrator(nodes);
    this.executor = new StepExecutor(nodes, token, (call, context) => this.executeControlTool(call, context));
  }

  async submit(raw: unknown, forceExecute?: boolean): Promise<RunResult> {
    const body = object(raw);
    const task = AgentTask.parse({ id: nanoid(), ...body, status: 'queued' });
    const execute = forceExecute ?? Boolean(body.execute);
    return this.runTask(task, execute);
  }

  async runTask(task: AgentTaskType, execute: boolean): Promise<RunResult> {
    this.store.put(task);
    let repairContext: string | undefined;
    let lastPlan: AgentPlan | undefined;
    let lastResults: unknown[] | undefined;
    let lastVerification: { pass: boolean; findings: string } | undefined;

    for (let attempt = 1; attempt <= task.maxAttempts; attempt++) {
      this.store.setStatus(task.id, attempt === 1 ? 'planning' : 'repairing', { attempt });
      const plan = await this.orchestrator.plan(task, repairContext);
      lastPlan = plan;
      this.store.event(task.id, 'plan.created', { attempt, plan });
      if (!execute) {
        this.store.setStatus(task.id, 'running', { plannedOnly: true });
        return { task, plan, executed: false, attempts: attempt };
      }

      this.store.setStatus(task.id, 'running', { attempt });
      const stepResults = await this.executePlan(task, plan);
      lastResults = stepResults;
      this.store.setStatus(task.id, 'verifying', { attempt });
      const verification = await this.orchestrator.verify(task, plan, JSON.stringify(stepResults).slice(-500_000));
      lastVerification = verification;
      this.store.event(task.id, 'verification.completed', { attempt, verification });
      if (verification.pass) {
        this.store.setStatus(task.id, 'succeeded', { attempt, verification });
        return { task, plan, executed: true, attempts: attempt, stepResults, verification };
      }
      if (attempt < task.maxAttempts) {
        repairContext = [verification.findings, 'Previous evidence:', JSON.stringify(stepResults).slice(-120_000)].join('\n');
        this.store.event(task.id, 'repair.requested', { attempt, findings: verification.findings });
      }
    }

    if (!lastPlan) throw new Error('task produced no plan');
    this.store.setStatus(task.id, 'failed', { verification: lastVerification });
    return { task, plan: lastPlan, executed: true, attempts: task.maxAttempts, stepResults: lastResults, verification: lastVerification };
  }

  private async executePlan(task: AgentTaskType, plan: AgentPlan): Promise<unknown[]> {
    const pending = new Map(plan.steps.map((step) => [step.id, step]));
    const completed = new Set<string>();
    const results: unknown[] = [];
    while (pending.size) {
      const ready = [...pending.values()].filter((step) => step.dependsOn.every((id) => completed.has(id)));
      if (!ready.length) throw new Error(`plan DAG is cyclic or has missing dependencies: ${[...pending.keys()].join(', ')}`);
      for (let offset = 0; offset < ready.length; offset += this.parallelism) {
        const batch = ready.slice(offset, offset + this.parallelism);
        const batchResults = await Promise.all(batch.map(async (step) => {
          this.store.event(task.id, 'step.started', { stepId: step.id, title: step.title });
          const result = await this.executor.execute(task, step, task.repoPath);
          this.store.event(task.id, 'step.completed', { stepId: step.id, result });
          return { step, result };
        }));
        for (const item of batchResults) { pending.delete(item.step.id); completed.add(item.step.id); results.push(item); }
      }
    }
    return results;
  }

  async executeControlTool(call: ToolCall, context?: { task: AgentTaskType; step: PlanStep; inferenceNode: NodeSpec; executionNode: NodeSpec }): Promise<ToolResult> {
    const descriptor = getTool(call.name);
    if (!descriptor || descriptor.scope !== 'control') return this.fail(call, `unknown control tool: ${call.name}`);
    const a = call.arguments;
    try {
      switch (call.name) {
        case 'web.search': {
          const data = await this.search.search(text(a.query), Math.max(1, Math.min(30, number(a.limit, 10))));
          return this.ok(call, data, JSON.stringify(data));
        }
        case 'web.fetch': {
          const data = await fetchDocument(text(a.url), Math.max(1_000, Math.min(200_000, number(a.maxChars, 60_000))));
          return this.ok(call, data, data.text);
        }
        case 'research.run': {
          const data = await this.research.run(text(a.query), Math.max(1, Math.min(4, number(a.maxRounds, 2))), Math.max(4, Math.min(30, number(a.maxSources, 12))));
          return this.ok(call, data, data.report);
        }
        case 'memory.search': {
          const rawKind = text(a.kind); const kind = memoryKinds.has(rawKind as MemoryKind) ? rawKind as MemoryKind : undefined;
          const data = this.memory.search(text(a.query), { namespace: text(a.namespace) || undefined, kind, limit: Math.max(1, Math.min(50, number(a.limit, 10))) });
          return this.ok(call, data, JSON.stringify(data));
        }
        case 'memory.store': {
          const kindValue = text(a.kind) as MemoryKind; if (!memoryKinds.has(kindValue)) throw new Error('invalid memory kind');
          const data = this.memory.store({ kind: kindValue, namespace: text(a.namespace, 'global'), content: text(a.content), importance: number(a.importance, 50), metadata: object(a.metadata) });
          return this.ok(call, data, JSON.stringify(data));
        }
        case 'node.status': return this.ok(call, this.nodes(), JSON.stringify(this.nodes()));
        case 'agent.delegate': {
          const depth = Number(context?.task.metadata.delegateDepth ?? 0); if (depth >= 4) throw new Error('delegate depth limit reached');
          const parsedKind = TaskKind.safeParse(a.kind); const constraints = [a.platform ? `platform=${text(a.platform)}` : '', a.region ? `region=${text(a.region)}` : ''].filter(Boolean).join(', ');
          const objective = `${text(a.objective)}${constraints ? `\nRequired execution constraints: ${constraints}` : ''}`;
          const child = AgentTask.parse({ id: nanoid(), objective, repoPath: text(a.repoPath) || context?.task.repoPath, kind: parsedKind.success ? parsedKind.data : 'general', status: 'queued', maxAttempts: Math.min(4, context?.task.maxAttempts ?? 4), metadata: { parentTaskId: context?.task.id ?? null, delegateDepth: depth + 1 } });
          const data = await this.runTask(child, true);
          return this.ok(call, data, JSON.stringify({ taskId: child.id, attempts: data.attempts, verification: data.verification, stepResults: data.stepResults }).slice(-100_000));
        }
        default: return this.fail(call, `unimplemented control tool: ${call.name}`);
      }
    } catch (error) { return this.fail(call, error instanceof Error ? error.message : String(error)); }
  }

  private ok(call: ToolCall, data: unknown, rendered: string): ToolResult { return { toolCallId: call.id, name: call.name, ok: true, text: rendered.slice(-120_000), data, images: [] }; }
  private fail(call: ToolCall, message: string): ToolResult { return { toolCallId: call.id, name: call.name, ok: false, text: message, images: [] }; }
}
