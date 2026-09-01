import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTask } from '@nexus/protocol';
import { TaskStore } from './store.js';

const tempDirs: string[] = [];

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-local-agent-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TaskStore native SQLite smoke test', () => {
  it('opens SQLite in WAL mode and persists task events', async () => {
    const store = new TaskStore(await stateDir());
    const task: AgentTask = {
      id: 'task-smoke',
      objective: 'verify native sqlite runtime',
      kind: 'test',
      status: 'queued',
      maxAttempts: 4,
      metadata: {}
    };

    store.put(task);
    store.setStatus(task.id, 'running', { worker: 'z13' });

    const result = store.get(task.id) as {
      task?: { id: string; status: string };
      events: Array<{ type: string }>;
    };

    expect(result.task).toMatchObject({ id: task.id, status: 'running' });
    expect(result.events.map((event) => event.type)).toEqual([
      'task.created',
      'task.running'
    ]);
  });
});
