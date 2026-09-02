import { describe, expect, it } from 'vitest';
import { NodeRegistry } from './registry.js';

describe('NodeRegistry public views', () => {
  it('keeps model credentials internal while preserving the routable model', () => {
    const registry = new NodeRegistry();
    registry.register({
      node: {
        id: 'brain',
        baseUrl: 'http://127.0.0.1:7790',
        platform: 'darwin-arm64',
        memoryGb: 128,
        capabilities: ['inference'],
        reachability: 'lan',
        tags: [],
        executionClass: 10,
        reliabilityClass: 95,
        models: [{
          id: 'local-model',
          provider: 'mlx-serve',
          baseUrl: 'http://127.0.0.1:18080/v1',
          apiKey: 'must-not-leak',
          contextWindow: 131072,
          maxOutputTokens: 32768,
          capabilities: ['reasoning'],
          costClass: 70,
          speedClass: 94,
          qualityClass: 98
        }]
      },
      metrics: {}
    });

    expect(registry.live()[0]?.models[0]?.apiKey).toBe('must-not-leak');
    expect(registry.publicList()[0]?.node.models[0]).not.toHaveProperty('apiKey');
  });
});
