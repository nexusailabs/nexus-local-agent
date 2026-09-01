import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentTask, TaskStatus } from '@nexus/protocol';

export class TaskStore {
  private db: Database.Database;
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(path.join(stateDir, 'nexus.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        repo_path TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        max_attempts INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_id_seq ON events(task_id, seq);
    `);
  }
  put(task: AgentTask) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tasks(id,objective,repo_path,kind,status,max_attempts,metadata_json,created_at,updated_at)
      VALUES(@id,@objective,@repoPath,@kind,@status,@maxAttempts,@metadata,@now,@now)`).run({
      ...task, repoPath: task.repoPath ?? null, metadata: JSON.stringify(task.metadata), now
    });
    this.event(task.id, 'task.created', task);
  }
  setStatus(id: string, status: TaskStatus, payload: unknown = {}) {
    this.db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
    this.event(id, `task.${status}`, payload);
  }
  event(taskId: string, type: string, payload: unknown) {
    this.db.prepare('INSERT INTO events(task_id,type,payload_json,created_at) VALUES(?,?,?,?)')
      .run(taskId, type, JSON.stringify(payload), new Date().toISOString());
  }
  get(id: string) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const events = this.db.prepare('SELECT seq,type,payload_json,created_at FROM events WHERE task_id=? ORDER BY seq').all(id);
    return { task, events };
  }
}
