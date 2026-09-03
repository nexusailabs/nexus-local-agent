import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "./index.js";

const temporary: string[] = [];
async function directory(prefix: string) {
  const result = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(result);
  return result;
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
async function repository() {
  const repo = await directory("nexus-source-");
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@nexus.local");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  await writeFile(path.join(repo, "tracked.txt"), "dirty\n");
  await writeFile(path.join(repo, "untracked.txt"), "visible\n");
  await mkdir(path.join(repo, "node_modules"));
  await writeFile(path.join(repo, "node_modules", "ignored.txt"), "ignored\n");
  return repo;
}

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("distributed workspace snapshots", () => {
  it("captures the current source and integrates a worker patch", async () => {
    const repo = await repository();
    const root = await directory("nexus-workspaces-");
    const manager = new WorktreeManager(root);
    const snapshot = await manager.snapshot(repo, "snapshot-one");
    const extracted = await directory("nexus-extracted-");
    execFileSync("tar", ["-xzf", snapshot.archivePath, "-C", extracted]);
    expect(await readFile(path.join(extracted, "tracked.txt"), "utf8")).toBe(
      "dirty\n",
    );
    expect(await readFile(path.join(extracted, "untracked.txt"), "utf8")).toBe(
      "visible\n",
    );
    await expect(
      readFile(path.join(extracted, "node_modules", "ignored.txt")),
    ).rejects.toThrow();

    const patch = [
      "diff --git a/tracked.txt b/tracked.txt",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1 +1 @@",
      "-dirty",
      "+worker",
      "",
    ].join("\n");
    await expect(manager.integrate(snapshot, [patch])).resolves.toMatchObject({
      changed: true,
    });
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(
      "worker\n",
    );
    await manager.release(snapshot);
  });

  it("leaves a concurrently changed source untouched", async () => {
    const repo = await repository();
    const root = await directory("nexus-workspaces-");
    const manager = new WorktreeManager(root);
    const snapshot = await manager.snapshot(repo, "snapshot-two");
    await writeFile(path.join(repo, "tracked.txt"), "external\n");
    const patch = [
      "diff --git a/tracked.txt b/tracked.txt",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1 +1 @@",
      "-dirty",
      "+worker",
      "",
    ].join("\n");
    await expect(manager.integrate(snapshot, [patch])).rejects.toThrow(
      "source was not modified",
    );
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(
      "external\n",
    );
    await manager.release(snapshot);
  });

  it("captures the current tree when a tracked file is deleted", async () => {
    const repo = await repository();
    await writeFile(path.join(repo, "deleted.txt"), "remove me\n");
    git(repo, "add", "deleted.txt");
    git(repo, "commit", "-qm", "add deleted fixture");
    await unlink(path.join(repo, "deleted.txt"));
    const root = await directory("nexus-workspaces-");
    const manager = new WorktreeManager(root);
    const snapshot = await manager.snapshot(repo, "snapshot-deletion");
    const extracted = await directory("nexus-extracted-");
    execFileSync("tar", ["-xzf", snapshot.archivePath, "-C", extracted]);
    await expect(
      readFile(path.join(extracted, "deleted.txt")),
    ).rejects.toThrow();
    await manager.release(snapshot);
  });

  it("does not partially apply conflicting worker patches", async () => {
    const repo = await repository();
    const root = await directory("nexus-workspaces-");
    const manager = new WorktreeManager(root);
    const snapshot = await manager.snapshot(repo, "snapshot-conflict");
    const patch = (value: string) =>
      [
        "diff --git a/tracked.txt b/tracked.txt",
        "--- a/tracked.txt",
        "+++ b/tracked.txt",
        "@@ -1 +1 @@",
        "-dirty",
        `+${value}`,
        "",
      ].join("\n");
    await expect(
      manager.integrate(snapshot, [patch("worker-one"), patch("worker-two")]),
    ).rejects.toThrow();
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe(
      "dirty\n",
    );
    await manager.release(snapshot);
  });
});
