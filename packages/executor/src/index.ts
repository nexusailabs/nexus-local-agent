import { z } from 'zod';
import type { AgentTask, NodeSpec, PlanStep } from '@nexus/protocol';
import { ExecResult } from '@nexus/protocol';
import { LocalModelClient } from '@nexus/provider';
import { routeStep } from '@nexus/router';

const AgentAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('exec'), argv: z.array(z.string()).min(1), cwd: z.string().optional(), rationale: z.string() }),
  z.object({ action: z.literal('done'), summary: z.string(), evidence: z.array(z.string()).default([]) })
]);
type AgentAction = z.infer<typeof AgentAction>;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

export class NodeClient {
  constructor(private readonly node: NodeSpec, private readonly token: string) {}

  async exec(argv: string[], cwd?: string): Promise<z.infer<typeof ExecResult>> {
    const body: Record<string, unknown> = { argv, timeoutMs: 600_000 };
    if (cwd) body.cwd = cwd;
    const res = await fetch(`${this.node.baseUrl}/v1/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`node ${this.node.id} exec failed: ${res.status} ${await res.text()}`);
    return ExecResult.parse(await res.json());
  }
}

export type StepExecution = {
  summary: string;
  evidence: string[];
  transcript: string[];
  routing: {
    inferenceNodeId: string;
    modelId: string;
    executionNodeId: string;
  };
};

export type NodeSource = () => NodeSpec[];

export class StepExecutor {
  constructor(private readonly nodes: NodeSource, private readonly token: string) {}

  async execute(task: AgentTask, step: PlanStep, cwd?: string, maxTurns = 20): Promise<StepExecution> {
    const nodes = this.nodes();
    const route = routeStep(nodes, step.kind, step.execution);
    const inferenceNode = nodes.find((node) => node.id === route.inference.nodeId);
    const executionNode = nodes.find((node) => node.id === route.execution.nodeId);
    const model = inferenceNode?.models.find((candidate) => candidate.id === route.inference.modelId);
    if (!inferenceNode || !executionNode || !model) throw new Error('routed node or model disappeared');

    const llm = new LocalModelClient(model);
    const remote = new NodeClient(executionNode, this.token);
    const transcript: string[] = [];
    const routing = {
      inferenceNodeId: inferenceNode.id,
      modelId: model.id,
      executionNodeId: executionNode.id
    };

    for (let turn = 0; turn < maxTurns; turn++) {
      const text = await llm.complete({
        system: [
          'You are an unattended local coding/execution agent.',
          `Your inference is running on ${inferenceNode.id}; commands execute on ${executionNode.id} (${executionNode.platform}${executionNode.region ? `, region=${executionNode.region}` : ''}).`,
          'Return exactly one JSON object and no prose.',
          'Allowed forms:',
          '{"action":"exec","argv":["command","arg"],"cwd":"optional absolute path","rationale":"why"}',
          '{"action":"done","summary":"what was accomplished","evidence":["verifiable fact",...]}.',
          'Use argv directly; do not wrap commands in a shell unless a shell is explicitly required.',
          'Do not claim completion unless acceptance criteria are supported by command output.'
        ].join('\n'),
        messages: [{
          role: 'user',
          content: [
            `Overall objective: ${task.objective}`,
            `Step: ${step.title} — ${step.description}`,
            `Acceptance: ${step.acceptance.join('; ') || 'none specified'}`,
            `Working directory: ${cwd ?? task.repoPath ?? 'unspecified'}`,
            `Routing: ${JSON.stringify(routing)}`,
            `Execution transcript:\n${transcript.slice(-8).join('\n\n') || '(empty)'}`
          ].join('\n')
        }],
        maxTokens: 4096
      });

      const action: AgentAction = AgentAction.parse(extractJson(text));
      if (action.action === 'done') {
        return { summary: action.summary, evidence: action.evidence, transcript, routing };
      }

      const result = await remote.exec(action.argv, action.cwd ?? cwd ?? task.repoPath);
      transcript.push(JSON.stringify({
        argv: action.argv,
        rationale: action.rationale,
        executionNodeId: executionNode.id,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(-16_000),
        stderr: result.stderr.slice(-16_000),
        durationMs: result.durationMs
      }));
    }

    throw new Error(`step ${step.id} exhausted ${maxTurns} turns`);
  }
}
