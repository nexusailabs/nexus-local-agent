export interface ControlRoute {
  name: string;
  controlUrl: string;
  nodeBaseUrl: string;
}

type Environment = Record<string, string | undefined>;

function normalizeHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty URL`);
  }

  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must use http or https`);
  }

  return url.toString().replace(/\/$/, "");
}

export function parseControlRoutes(env: Environment): ControlRoute[] {
  const configuredRoutes = env.NEXUS_CONTROL_ROUTES_JSON;
  if (configuredRoutes) {
    const parsed: unknown = JSON.parse(configuredRoutes);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("NEXUS_CONTROL_ROUTES_JSON must be a non-empty array");
    }

    return parsed.map((candidate, index) => {
      if (!candidate || typeof candidate !== "object") {
        throw new Error(`control route ${index} must be an object`);
      }
      const route = candidate as Record<string, unknown>;
      return {
        name:
          typeof route.name === "string" && route.name.trim()
            ? route.name
            : `route-${index + 1}`,
        controlUrl: normalizeHttpUrl(
          route.controlUrl,
          `control route ${index} controlUrl`,
        ),
        nodeBaseUrl: normalizeHttpUrl(
          route.nodeBaseUrl,
          `control route ${index} nodeBaseUrl`,
        ),
      };
    });
  }

  if (!env.NEXUS_CONTROL_URL) return [];
  if (!env.NEXUS_NODE_BASE_URL) {
    throw new Error(
      "NEXUS_NODE_BASE_URL is required when registering with a remote control plane",
    );
  }

  return [
    {
      name: "default",
      controlUrl: normalizeHttpUrl(env.NEXUS_CONTROL_URL, "NEXUS_CONTROL_URL"),
      nodeBaseUrl: normalizeHttpUrl(
        env.NEXUS_NODE_BASE_URL,
        "NEXUS_NODE_BASE_URL",
      ),
    },
  ];
}

export class ControlRouteRegistration {
  private activeIndex = -1;

  constructor(
    readonly routes: readonly ControlRoute[],
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 2_000,
  ) {
    if (routes.length === 0)
      throw new Error("at least one control route is required");
  }

  get activeRoute(): ControlRoute | undefined {
    return this.routes[this.activeIndex];
  }

  private async post(
    route: ControlRoute,
    pathname: string,
    body: unknown,
  ): Promise<Response> {
    return this.fetchImpl(`${route.controlUrl}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async tryRegister(
    start: number,
    end: number,
    advertisementFor: (route: ControlRoute) => unknown,
  ): Promise<ControlRoute | undefined> {
    for (let index = start; index < end; index += 1) {
      const route = this.routes[index];
      if (!route) continue;
      try {
        const response = await this.post(
          route,
          "/v1/nodes/register",
          advertisementFor(route),
        );
        if (!response.ok) continue;
        this.activeIndex = index;
        return route;
      } catch {
        // Try the next route. A later heartbeat promotes back to the first route.
      }
    }
    return undefined;
  }

  async register(
    advertisementFor: (route: ControlRoute) => unknown,
  ): Promise<ControlRoute> {
    const route = await this.tryRegister(
      0,
      this.routes.length,
      advertisementFor,
    );
    if (!route)
      throw new Error("registration failed on every configured control route");
    return route;
  }

  async heartbeat(
    pathname: string,
    payload: unknown,
    advertisementFor: (route: ControlRoute) => unknown,
  ): Promise<ControlRoute> {
    if (this.activeIndex < 0) return this.register(advertisementFor);

    if (this.activeIndex > 0) {
      const preferred = await this.tryRegister(
        0,
        this.activeIndex,
        advertisementFor,
      );
      if (preferred) return preferred;
    }

    const current = this.routes[this.activeIndex];
    if (!current) return this.register(advertisementFor);
    try {
      const response = await this.post(current, pathname, payload);
      if (response.ok) return current;
    } catch {
      // Fall through and re-register using the ordered route list.
    }

    this.activeIndex = -1;
    return this.register(advertisementFor);
  }
}
