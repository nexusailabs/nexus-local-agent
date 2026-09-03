import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";

async function run(
  argv: string[],
  cwd?: string,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (err += data));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(err || `${argv.join(" ")} failed: ${code}`)),
    );
    child.stdin.end(input);
  });
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function gitFiles(repoPath: string): Promise<string[]> {
  const output = await run(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    repoPath,
  );
  const listed = output.split("\0").filter(Boolean).sort();
  const present: string[] = [];
  for (const file of listed) {
    try {
      await lstat(path.join(repoPath, safeRelative(file)));
      present.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return present;
}

function safeRelative(file: string): string {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new Error(`unsafe repository path: ${file}`);
  }
  return file;
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
  } else if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of await readdir(source)) {
      if (child === ".git") continue;
      await copyEntry(path.join(source, child), path.join(destination, child));
    }
  } else if (info.isFile()) {
    await copyFile(source, destination);
    await chmod(destination, info.mode);
  } else {
    throw new Error(`unsupported repository entry: ${source}`);
  }
}

async function hashEntry(
  hash: ReturnType<typeof createHash>,
  absolute: string,
  relative: string,
): Promise<void> {
  const info = await lstat(absolute);
  hash.update(`${relative}\0${info.mode}\0`);
  if (info.isSymbolicLink()) {
    hash.update(`link\0${await readlink(absolute)}\0`);
  } else if (info.isDirectory()) {
    hash.update("dir\0");
    for (const child of (await readdir(absolute)).sort()) {
      if (child === ".git") continue;
      await hashEntry(
        hash,
        path.join(absolute, child),
        path.posix.join(relative, child),
      );
    }
  } else if (info.isFile()) {
    hash.update("file\0");
    hash.update(await readFile(absolute));
  }
}

async function fingerprint(
  repoPath: string,
  files?: string[],
): Promise<string> {
  const selected = files ?? (await gitFiles(repoPath));
  const hash = createHash("sha256");
  for (const file of selected) {
    const relative = safeRelative(file);
    await hashEntry(hash, path.join(repoPath, relative), relative);
  }
  return hash.digest("hex");
}

async function initializeBaseline(directory: string): Promise<void> {
  await run(["git", "init", "-q"], directory);
  await run(["git", "config", "user.name", "Nexus Workspace"], directory);
  await run(
    ["git", "config", "user.email", "workspace@nexus.local"],
    directory,
  );
  await run(["git", "add", "-A"], directory);
  await run(
    ["git", "commit", "-q", "--allow-empty", "-m", "Nexus workspace baseline"],
    directory,
  );
}

export type WorkspaceSnapshot = {
  id: string;
  repoPath: string;
  archivePath: string;
  sha256: string;
  fingerprint: string;
  bytes: number;
  files: number;
  temporaryDirectory: string;
};

export class WorktreeManager {
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();

  constructor(
    private readonly root = ".worktrees",
    private readonly maxArchiveBytes = Number(
      process.env.NEXUS_WORKSPACE_MAX_BYTES ?? 256 * 1024 * 1024,
    ),
  ) {}

  async snapshot(repoPath: string, id: string): Promise<WorkspaceSnapshot> {
    const topLevel = (
      await run(["git", "rev-parse", "--show-toplevel"], repoPath)
    ).trim();
    const sourceRoot = await realpath(topLevel);
    await mkdir(this.root, { recursive: true });
    const temporaryDirectory = await mkdtemp(path.join(this.root, "snapshot-"));
    const tree = path.join(temporaryDirectory, "tree");
    await mkdir(tree);
    const files = await gitFiles(sourceRoot);
    for (const file of files) {
      const relative = safeRelative(file);
      await copyEntry(
        path.join(sourceRoot, relative),
        path.join(tree, relative),
      );
    }
    const archivePath = path.join(temporaryDirectory, "workspace.tar.gz");
    await run(["tar", "-czf", archivePath, "-C", tree, "."]);
    const bytes = (await stat(archivePath)).size;
    if (bytes > this.maxArchiveBytes) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw new Error(
        `workspace archive is ${bytes} bytes, above NEXUS_WORKSPACE_MAX_BYTES=${this.maxArchiveBytes}`,
      );
    }
    const snapshot: WorkspaceSnapshot = {
      id,
      repoPath: sourceRoot,
      archivePath,
      sha256: await sha256File(archivePath),
      fingerprint: await fingerprint(sourceRoot, files),
      bytes,
      files: files.length,
      temporaryDirectory,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  archive(id: string): WorkspaceSnapshot | undefined {
    return this.snapshots.get(id);
  }

  async integrate(
    snapshot: WorkspaceSnapshot,
    patches: string[],
  ): Promise<{ patch: string; changed: boolean }> {
    const integrationRoot = await mkdtemp(path.join(this.root, "integrate-"));
    try {
      await run(["tar", "-xzf", snapshot.archivePath, "-C", integrationRoot]);
      await initializeBaseline(integrationRoot);
      for (const patchText of patches.filter((value) => value.trim())) {
        await run(
          ["git", "apply", "--binary", "--whitespace=nowarn", "-"],
          integrationRoot,
          patchText,
        );
      }
      await run(["git", "add", "-A"], integrationRoot);
      const combined = await run(
        ["git", "diff", "--cached", "--binary", "--full-index", "HEAD"],
        integrationRoot,
      );
      if (!combined.trim()) return { patch: "", changed: false };
      const currentFingerprint = await fingerprint(snapshot.repoPath);
      if (currentFingerprint !== snapshot.fingerprint) {
        throw new Error(
          "source repository changed while remote work was running; source was not modified",
        );
      }
      await run(
        ["git", "apply", "--binary", "--whitespace=nowarn", "-"],
        snapshot.repoPath,
        combined,
      );
      return { patch: combined, changed: true };
    } finally {
      await rm(integrationRoot, { recursive: true, force: true });
    }
  }

  async release(snapshot: WorkspaceSnapshot): Promise<void> {
    this.snapshots.delete(snapshot.id);
    await rm(snapshot.temporaryDirectory, { recursive: true, force: true });
  }

  async create(repoPath: string, taskId: string): Promise<string> {
    const absRoot = path.resolve(repoPath, this.root);
    await mkdir(absRoot, { recursive: true });
    const dir = path.join(absRoot, taskId);
    const branch = `nexus/${taskId}`;
    await run(["git", "worktree", "add", "-b", branch, dir, "HEAD"], repoPath);
    return dir;
  }

  async diff(worktreePath: string): Promise<string> {
    return run(["git", "diff", "--stat", "HEAD"], worktreePath);
  }

  async cleanup(repoPath: string, worktreePath: string): Promise<void> {
    await run(["git", "worktree", "remove", "--force", worktreePath], repoPath);
  }
}
