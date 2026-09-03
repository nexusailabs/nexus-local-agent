import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@nexus/protocol";
import { toolsForStep } from "./index.js";

const node: NodeSpec = {
  id: "z13",
  baseUrl: "http://z13:7790",
  platform: "linux-x64",
  memoryGb: 64,
  capabilities: ["exec", "fs", "git", "code", "browser"],
  reachability: "lan",
  tags: [],
  executionClass: 90,
  reliabilityClass: 90,
  models: [],
};
describe("tool catalog", () => {
  it("only exposes node tools backed by advertised capabilities", () => {
    const names = toolsForStep("code", node).map((tool) => tool.name);
    expect(names).toContain("code.run");
    expect(names).toContain("browser.screenshot");
    expect(names).not.toContain("computer.click");
    expect(names).not.toContain("workspace.prepare");
    expect(names).toContain("memory.search");
  });
});
