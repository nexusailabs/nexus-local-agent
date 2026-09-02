import type { NodeAdvertisement, NodeHeartbeat, NodeMetrics, NodeSpec, RuntimeNode } from '@nexus/protocol';

type Entry = {
  node: NodeSpec;
  metrics: NodeMetrics;
  source: 'dynamic' | 'bootstrap';
  lastSeenAt: number;
};

export class NodeRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    bootstrapNodes: NodeSpec[] = [],
    private readonly ttlMs = 45_000
  ) {
    const now = Date.now();
    for (const node of bootstrapNodes) {
      this.entries.set(node.id, { node, metrics: {}, source: 'bootstrap', lastSeenAt: now });
    }
  }

  register(advertisement: NodeAdvertisement): RuntimeNode {
    const now = advertisement.ts ? Date.parse(advertisement.ts) : Date.now();
    this.entries.set(advertisement.node.id, {
      node: advertisement.node,
      metrics: advertisement.metrics,
      source: 'dynamic',
      lastSeenAt: Number.isFinite(now) ? now : Date.now()
    });
    return this.toRuntime(this.entries.get(advertisement.node.id)!);
  }

  heartbeat(heartbeat: NodeHeartbeat): RuntimeNode {
    const entry = this.entries.get(heartbeat.nodeId);
    if (!entry) throw new Error(`node ${heartbeat.nodeId} is not registered`);
    const observed = heartbeat.ts ? Date.parse(heartbeat.ts) : Date.now();
    entry.metrics = heartbeat.metrics;
    entry.lastSeenAt = Number.isFinite(observed) ? observed : Date.now();
    return this.toRuntime(entry);
  }

  list(includeStale = true): RuntimeNode[] {
    return [...this.entries.values()]
      .map((entry) => this.toRuntime(entry))
      .filter((entry) => includeStale || entry.status === 'online')
      .sort((a, b) => a.node.id.localeCompare(b.node.id));
  }

  publicList(includeStale = true): RuntimeNode[] {
    return this.list(includeStale).map((entry) => ({
      ...entry,
      node: {
        ...entry.node,
        models: entry.node.models.map((model) => {
          const publicModel = { ...model };
          delete publicModel.apiKey;
          return publicModel;
        })
      }
    }));
  }

  live(): NodeSpec[] {
    return this.list(false).map((entry) => entry.node);
  }

  private toRuntime(entry: Entry): RuntimeNode {
    const status = entry.source === 'bootstrap' || Date.now() - entry.lastSeenAt <= this.ttlMs
      ? 'online'
      : 'stale';
    return {
      node: entry.node,
      metrics: entry.metrics,
      source: entry.source,
      status,
      lastSeenAt: new Date(entry.lastSeenAt).toISOString()
    };
  }
}
