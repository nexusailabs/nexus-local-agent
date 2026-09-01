import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function run(argv: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `${argv.join(' ')} failed: ${code}`)));
  });
}

export class WorktreeManager {
  constructor(private readonly root = '.worktrees') {}

  async create(repoPath: string, taskId: string): Promise<string> {
    const absRoot = path.resolve(repoPath, this.root);
    await mkdir(absRoot, { recursive: true });
    const dir = path.join(absRoot, taskId);
    const branch = `nexus/${taskId}`;
    await run(['git', 'worktree', 'add', '-b', branch, dir, 'HEAD'], repoPath);
    return dir;
  }

  async diff(worktreePath: string): Promise<string> {
    return run(['git', 'diff', '--stat', 'HEAD'], worktreePath);
  }

  async cleanup(repoPath: string, worktreePath: string): Promise<void> {
    await run(['git', 'worktree', 'remove', '--force', worktreePath], repoPath);
  }
}
