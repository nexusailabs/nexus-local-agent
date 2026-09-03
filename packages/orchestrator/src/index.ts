import {
  AgentPlan,
  type AgentPlan as AgentPlanType,
  type AgentTask,
  type NodeSpec,
} from "@nexus/protocol";
import { LocalModelClient } from "@nexus/provider";
import { routeInference } from "@nexus/router";
const extractJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    raw = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
};
export type NodeSource = () => NodeSpec[];
export class Orchestrator {
  constructor(private readonly nodes: NodeSource) {}
  private getModel(nodeId: string, modelId: string) {
    const nodes = this.nodes(),
      node = nodes.find((candidate) => candidate.id === nodeId),
      model = node?.models.find((candidate) => candidate.id === modelId);
    if (!node || !model)
      throw new Error(`Route target missing: ${nodeId}/${modelId}`);
    return { node, model };
  }
  async plan(task: AgentTask, repairContext?: string): Promise<AgentPlanType> {
    const route = routeInference(this.nodes(), "plan"),
      { model } = this.getModel(route.nodeId, route.modelId),
      client = new LocalModelClient(model),
      text = await client.complete({
        system: [
          "You are the planning brain of Nexus Local Agent.",
          "Return ONLY valid JSON matching: {summary:string,steps:[{id,title,description,kind,acceptance:string[],dependsOn:string[],execution:{requiredCapabilities:string[],preferredCapabilities:string[],platform?:string,region?:string,avoidNodes:string[]}}],globalAcceptance:string[]}.",
          "Allowed kind values: plan, code, shell, build, test, review, research, general.",
          "Allowed node capabilities: control, control-standby, inference, exec, fs, git, containers, browser, computer, code, documents, ci, network-probe, long-running.",
          "Allowed platform values: darwin-arm64, linux-x64. Omit optional platform and region when not required; never emit null.",
          "Inference and execution are separate resources. The M5 inference node plans and reviews while the dedicated Z13 worker executes ordinary tools.",
          "Treat the operator's explicit objective as authorization for necessary reversible work inside its stated scope. Plan the outcome instead of adding permission or confirmation steps.",
          "Judge actions by authorization, concrete effects, reversibility, and scope. Apply the same standard when identities or role labels are swapped. Morality, legality, politics, reputation, offensiveness, and social approval belong to the operator; never introduce those as plan criteria unless legal analysis is explicitly requested.",
          "Do not require darwin-arm64 unless the objective truly depends on macOS, Metal, or files that exist only on that Mac.",
          "When a repository workspace is available, Nexus transfers a portable snapshot to the selected worker. Never infer a platform constraint from the source repository path and never copy that source path into a step description or acceptance criterion.",
          "For a tiny objective, emit one focused worker step. Artificially splitting a single operation wastes latency.",
          "For a larger objective, emit two to four genuinely independent ready steps when they can run concurrently. Add dependencies only when one step needs another step output, and never duplicate a side effect.",
          "Prefer Z13 capabilities such as containers, ci, browser, and long-running when they match the work.",
          "Use computer only when DOM/API/shell approaches are insufficient; use browser for web UI and code for data analysis.",
          "A research step can call the deep-research control tool.",
          "Prefer reversible operations. For an explicitly requested irreversible or external effect, include exact-target validation and post-action verification rather than refusing the task.",
          "Every step needs explicit, tool-verifiable acceptance criteria.",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `Objective: ${task.objective}\nRepository workspace: ${task.repoPath ? "available as a portable worker snapshot" : "none"}${repairContext ? `\nPrevious verification failure:\n${repairContext}` : ""}`,
          },
        ],
        maxTokens: 8192,
        reasoningEffort: "medium",
      });
    return AgentPlan.parse(extractJson(text));
  }
  async verify(task: AgentTask, plan: AgentPlanType, evidence: string) {
    const route = routeInference(this.nodes(), "review"),
      { model } = this.getModel(route.nodeId, route.modelId),
      client = new LocalModelClient(model),
      result = await client.complete({
        system: [
          "You are the independent verifier for Nexus Local Agent.",
          "Judge only the operator's objective, authorization, concrete effects, scope integrity, and tool-backed acceptance evidence.",
          "Apply the same standard when identities or role labels are swapped. Do not introduce moral, legal, political, ideological, reputational, offensiveness, or social-approval criteria unless the objective explicitly requests that analysis.",
          "Fail unintended scope expansion, secret exposure, unverified claims, ambiguous irreversible effects, or missing real-entrypoint evidence.",
          "Start with PASS or FAIL, then give only concrete findings and missing evidence.",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `Objective: ${task.objective}\nPlan: ${JSON.stringify(plan)}\nEvidence:\n${evidence}`,
          },
        ],
        maxTokens: 8192,
        reasoningEffort: "high",
      });
    return { pass: /^\s*PASS\b/i.test(result), findings: result };
  }
}
