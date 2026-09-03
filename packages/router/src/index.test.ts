import { describe, expect, it } from "vitest";
import type { NodeSpec } from "@nexus/protocol";
import { routeExecution, routeInference, routeStep } from "./index.js";

const nodes: NodeSpec[] = [
  {
    id: "m5",
    baseUrl: "http://m5:7790",
    platform: "darwin-arm64",
    memoryGb: 128,
    capabilities: ["inference"],
    reachability: "lan",
    tags: ["metal"],
    executionClass: 20,
    reliabilityClass: 95,
    models: [
      {
        id: "heavy",
        provider: "omlx",
        baseUrl: "http://m5:8080/v1",
        contextWindow: 65536,
        maxOutputTokens: 16384,
        capabilities: [
          "reasoning",
          "coding",
          "tool-use",
          "long-context",
          "review",
        ],
        costClass: 70,
        speedClass: 72,
        qualityClass: 96,
      },
    ],
  },
  {
    id: "z13",
    baseUrl: "http://z13:7790",
    platform: "linux-x64",
    memoryGb: 64,
    capabilities: [
      "inference",
      "exec",
      "fs",
      "git",
      "containers",
      "browser",
      "ci",
      "long-running",
    ],
    reachability: "lan",
    tags: ["rocm"],
    executionClass: 96,
    reliabilityClass: 90,
    models: [
      {
        id: "coder",
        provider: "llama.cpp",
        baseUrl: "http://z13:8081/v1",
        contextWindow: 65536,
        maxOutputTokens: 16384,
        capabilities: [
          "reasoning",
          "coding",
          "tool-use",
          "long-context",
          "review",
        ],
        costClass: 35,
        speedClass: 60,
        qualityClass: 88,
      },
    ],
  },
  {
    id: "hk-mini",
    baseUrl: "http://hk-mini:7790",
    platform: "darwin-arm64",
    memoryGb: 16,
    capabilities: [
      "exec",
      "fs",
      "git",
      "browser",
      "ci",
      "network-probe",
      "long-running",
      "control-standby",
    ],
    reachability: "wan",
    region: "hk",
    tags: ["remote"],
    executionClass: 62,
    reliabilityClass: 92,
    models: [],
  },
];

describe("heterogeneous routing", () => {
  it("routes planning inference to the heavy M5 model", () => {
    expect(routeInference(nodes, "plan")).toMatchObject({
      nodeId: "m5",
      modelId: "heavy",
    });
  });

  it("separates inference and execution targets", () => {
    const route = routeStep(nodes, "code");
    expect(route.inference.nodeId).toBeDefined();
    expect(route.execution.nodeId).toBe("z13");
  });

  it("keeps a remote Z13 worker ahead of the M5 failover executor", () => {
    const configured = nodes.map((node) =>
      node.id === "m5"
        ? {
            ...node,
            capabilities: [
              "inference",
              "exec",
              "fs",
              "git",
              "code",
            ] as NodeSpec["capabilities"],
            executionClass: 10,
          }
        : node.id === "z13"
          ? { ...node, reachability: "wan" as const }
          : node,
    );

    expect(routeExecution(configured, "code").nodeId).toBe("z13");
    expect(routeExecution(configured, "shell").nodeId).toBe("z13");
  });

  it("can force a Hong Kong macOS execution environment without requiring a model there", () => {
    const route = routeExecution(nodes, "test", {
      requiredCapabilities: ["ci"],
      preferredCapabilities: [],
      platform: "darwin-arm64",
      region: "hk",
      avoidNodes: [],
    });
    expect(route.nodeId).toBe("hk-mini");
  });
});
