import { AgentPlan, type AgentPlan as AgentPlanType, type AgentTask, type NodeSpec } from '@nexus/protocol';
import { LocalModelClient } from '@nexus/provider';
import { routeInference } from '@nexus/router';

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

export type NodeSource = () => NodeSpec[];

export class Orchestrator {
  constructor(private readonly nodes: NodeSource) {}

  private getModel(nodeId: string, modelId: string) {
    const nodes = this.nodes();
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const model = node?.models.find((candidate) => candidate.id === modelId);
    if (!node || !model) throw new Error(`Route target missing: ${nodeId}/${modelId}`);
    return { node, model };
  }

  async plan(task: AgentTask): Promise<AgentPlanType> {
    const route = routeInference(this.nodes(), 'plan');
    const { model } = this.getModel(route.nodeId, route.modelId);
    const client = new LocalModelClient(model);
    const text = await client.complete({
      system: [
        'You are the planning brain of Nexus Local Agent.',
        'Return ONLY valid JSON matching:',
        '{summary:string,steps:[{id,title,description,kind,acceptance:string[],dependsOn:string[],execution:{requiredCapabilities:string[],preferredCapabilities:string[],platform?:string,region?:string,avoidNodes:string[]}}],globalAcceptance:string[]}.',
        'Inference and execution are separate resources. A step may execute on a node that runs no model.',
        'Use execution constraints only when they are materially required, e.g. macOS clean CI or region=hk.',
        'Prefer executable, independently verifiable steps.'
      ].join('\n'),
      messages: [{ role: 'user', content: `Objective: ${task.objective}\nRepository: ${task.repoPath ?? 'none'}` }],
      maxTokens: 8192
    });
    return AgentPlan.parse(extractJson(text));
  }

  async verify(task: AgentTask, plan: AgentPlanType, evidence: string): Promise<{ pass: boolean; findings: string }> {
    const route = routeInference(this.nodes(), 'review');
    const { model } = this.getModel(route.nodeId, route.modelId);
    const client = new LocalModelClient(model);
    const result = await client.complete({
      system: 'You are the independent verifier. Judge correctness against objective and acceptance criteria, not style. Start with PASS or FAIL, then concise findings.',
      messages: [{ role: 'user', content: `Objective: ${task.objective}\nPlan: ${JSON.stringify(plan)}\nEvidence:\n${evidence}` }],
      maxTokens: 8192
    });
    return { pass: /^\s*PASS\b/i.test(result), findings: result };
  }
}
