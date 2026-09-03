import { describe, expect, it, vi } from "vitest";
import {
  ControlRouteRegistration,
  parseControlRoutes,
} from "./control-routes.js";

const routes = [
  {
    name: "tb4",
    controlUrl: "http://169.254.77.3:7788",
    nodeBaseUrl: "http://169.254.77.1:7790",
  },
  {
    name: "tailscale",
    controlUrl: "http://100.81.53.61:7788",
    nodeBaseUrl: "http://100.107.237.37:7790",
  },
];

describe("control route configuration", () => {
  it("preserves the configured preference order", () => {
    expect(
      parseControlRoutes({ NEXUS_CONTROL_ROUTES_JSON: JSON.stringify(routes) }),
    ).toEqual(routes);
  });

  it("keeps the legacy single-route configuration working", () => {
    expect(
      parseControlRoutes({
        NEXUS_CONTROL_URL: "http://control:7788/",
        NEXUS_NODE_BASE_URL: "http://node:7790/",
      }),
    ).toEqual([
      {
        name: "default",
        controlUrl: "http://control:7788",
        nodeBaseUrl: "http://node:7790",
      },
    ]);
  });
});

describe("ControlRouteRegistration", () => {
  it("falls back to Tailscale and promotes back to TB4 when it returns", async () => {
    let tb4Available = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(routes[0]!.controlUrl) && !tb4Available)
        throw new Error("TB4 unavailable");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const registration = new ControlRouteRegistration(
      routes,
      "token",
      fetchImpl,
      50,
    );
    const advertisementFor = (route: (typeof routes)[number]) => ({
      node: { baseUrl: route.nodeBaseUrl },
    });

    await expect(registration.register(advertisementFor)).resolves.toEqual(
      routes[1],
    );
    expect(registration.activeRoute).toEqual(routes[1]);

    tb4Available = true;
    await expect(
      registration.heartbeat("/v1/nodes/mbp/heartbeat", {}, advertisementFor),
    ).resolves.toEqual(routes[0]);
    expect(registration.activeRoute).toEqual(routes[0]);
  });

  it("moves from TB4 to Tailscale when the active route fails", async () => {
    let tb4Available = true;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(routes[0]!.controlUrl) && !tb4Available)
        throw new Error("TB4 unavailable");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const registration = new ControlRouteRegistration(
      routes,
      "token",
      fetchImpl,
      50,
    );
    const advertisementFor = (route: (typeof routes)[number]) => ({
      node: { baseUrl: route.nodeBaseUrl },
    });

    await expect(registration.register(advertisementFor)).resolves.toEqual(
      routes[0],
    );
    tb4Available = false;
    await expect(
      registration.heartbeat("/v1/nodes/mbp/heartbeat", {}, advertisementFor),
    ).resolves.toEqual(routes[1]);
    expect(registration.activeRoute).toEqual(routes[1]);
  });
});
