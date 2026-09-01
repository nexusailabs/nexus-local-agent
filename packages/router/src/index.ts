import type { NodeSpec, TaskKind } from '@nexus/protocol';

export type RouteDecision = {
  nodeId: string;
  modelId: string;
  score: number;
  reasons: string[];
};

const kindCaps: Record<TaskKind, string[]> = {
  plan: ['reasoning', 'long-context'],
  code: ['coding', 'tool-use'],
  shell: ['tool-use'],
  build: ['tool-use'],
  test: ['tool-use', 'coding'],
  review: ['review', 'reasoning', 'coding'],
  research: ['reasoning', 'long-context'],
  general: ['reasoning']
};

export function routeTask(nodes: NodeSpec[], kind: TaskKind): RouteDecision {
  const required = kindCaps[kind] ?? [];
  const candidates = nodes.flatMap((node) => node.models.map((model) => ({ node, model })));
  if (candidates.length === 0) throw new Error('No models registered');

  const scored = candidates.map(({ node, model }) => {
    const capScore = required.reduce((n, cap) => n + (model.capabilities.includes(cap as never) ? 18 : -10), 0);
    const brainBias = ['plan', 'review', 'research'].includes(kind) && node.role === 'brain' ? 15 : 0;
    const workerBias = ['code', 'shell', 'build', 'test'].includes(kind) && node.role === 'worker' ? 12 : 0;
    const score = capScore + brainBias + workerBias + model.qualityClass * 0.45 + model.speedClass * 0.25 - model.costClass * 0.05;
    return {
      nodeId: node.id,
      modelId: model.id,
      score,
      reasons: [`capabilities:${capScore}`, `quality:${model.qualityClass}`, `speed:${model.speedClass}`, `role:${node.role}`]
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]!;
}
