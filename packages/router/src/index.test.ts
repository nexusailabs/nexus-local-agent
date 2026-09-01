import { describe, expect, it } from 'vitest';
import { routeTask } from './index.js';
import type { NodeSpec } from '@nexus/protocol';

const nodes: NodeSpec[] = [
  { id:'brain', role:'brain', baseUrl:'http://127.0.0.1:1', platform:'darwin-arm64', memoryGb:128, tags:[], models:[
    {id:'large', provider:'omlx', baseUrl:'http://127.0.0.1:2/v1', contextWindow:65536,maxOutputTokens:8192,capabilities:['reasoning','review','coding','long-context'],costClass:70,speedClass:50,qualityClass:99}
  ]},
  { id:'worker', role:'worker', baseUrl:'http://127.0.0.1:3', platform:'linux-x64', memoryGb:64, tags:[], models:[
    {id:'coder', provider:'llama.cpp', baseUrl:'http://127.0.0.1:4/v1', contextWindow:65536,maxOutputTokens:8192,capabilities:['coding','tool-use','reasoning'],costClass:30,speedClass:75,qualityClass:88}
  ]}
];

describe('routeTask', () => {
  it('prefers brain for review', () => expect(routeTask(nodes, 'review').nodeId).toBe('brain'));
  it('prefers worker for shell', () => expect(routeTask(nodes, 'shell').nodeId).toBe('worker'));
});
