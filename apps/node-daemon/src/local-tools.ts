import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { NodeSpec, ToolCall, ToolResult } from "@nexus/protocol";
import { getTool } from "@nexus/tools";
import { BrowserManager } from "./browser.js";
import { DesktopController } from "./computer.js";
import { commandExists, runProcess } from "./process.js";
const text = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value)
    throw new Error(`${name} must be a non-empty string`);
  return value;
};
const optionalText = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;
const number = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown) => value === true;
export class LocalToolRuntime {
  readonly browser = new BrowserManager();
  readonly desktop = new DesktopController();
  private readonly workspaceRoot =
    process.env.NEXUS_WORKSPACE_ROOT ?? "/var/tmp/nexus-workspaces";
  constructor(
    private readonly node: NodeSpec,
    private readonly token = process.env.NEXUS_SHARED_TOKEN ?? "",
  ) {}
  private ensure(call: ToolCall) {
    const descriptor = getTool(call.name);
    if (!descriptor || descriptor.scope !== "node")
      throw new Error(`unknown node tool: ${call.name}`);
    for (const cap of descriptor.requiredCapabilities)
      if (!this.node.capabilities.includes(cap))
        throw new Error(`node ${this.node.id} lacks ${cap} for ${call.name}`);
    return descriptor;
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      this.ensure(call);
      const a = call.arguments;
      let data: unknown;
      let images: ToolResult["images"] = [];
      switch (call.name) {
        case "shell.exec":
          data = await runProcess(((a.argv as unknown[]) ?? []).map(String), {
            cwd: optionalText(a.cwd),
            timeoutMs: number(a.timeoutMs, 600_000),
          });
          break;
        case "fs.read": {
          const file = text(a.path, "path");
          data = {
            path: file,
            content: (await readFile(file, "utf8")).slice(0, 500_000),
          };
          break;
        }
        case "fs.write": {
          const file = text(a.path, "path");
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, text(a.content, "content"), "utf8");
          data = { path: file, bytes: Buffer.byteLength(String(a.content)) };
          break;
        }
        case "git.status":
          data = await runProcess(["git", "status", "--porcelain=v1", "-b"], {
            cwd: optionalText(a.cwd),
          });
          break;
        case "git.diff":
          data = await runProcess(
            ["git", "diff", ...(bool(a.staged) ? ["--cached"] : [])],
            { cwd: optionalText(a.cwd) },
          );
          break;
        case "code.run":
          data = await this.runCode(
            text(a.language, "language"),
            text(a.code, "code"),
            optionalText(a.cwd),
            number(a.timeoutMs, 120_000),
          );
          break;
        case "document.read":
          data = await this.readDocument(
            text(a.path, "path"),
            number(a.maxBytes, 2_000_000),
          );
          break;
        case "browser.open":
          data = await this.browser.open({
            sessionId: optionalText(a.sessionId),
            url: optionalText(a.url),
            headless: a.headless === undefined ? undefined : bool(a.headless),
          });
          break;
        case "browser.navigate":
          data = await this.browser.navigate(
            text(a.sessionId, "sessionId"),
            text(a.url, "url"),
          );
          break;
        case "browser.click":
          data = await this.browser.click({
            sessionId: text(a.sessionId, "sessionId"),
            selector: optionalText(a.selector),
            x: typeof a.x === "number" ? a.x : undefined,
            y: typeof a.y === "number" ? a.y : undefined,
          });
          break;
        case "browser.type":
          data = await this.browser.type({
            sessionId: text(a.sessionId, "sessionId"),
            selector: optionalText(a.selector),
            text: text(a.text, "text"),
          });
          break;
        case "browser.extract":
          data = await this.browser.extract({
            sessionId: text(a.sessionId, "sessionId"),
            selector: optionalText(a.selector),
            mode: a.mode === "html" ? "html" : "text",
          });
          break;
        case "browser.screenshot": {
          const shot = await this.browser.screenshot({
            sessionId: text(a.sessionId, "sessionId"),
            fullPage: bool(a.fullPage),
          });
          images = [{ mimeType: shot.mimeType, dataBase64: shot.dataBase64 }];
          data = {
            sessionId: shot.sessionId,
            url: shot.url,
            title: shot.title,
          };
          break;
        }
        case "browser.close":
          data = await this.browser.close(text(a.sessionId, "sessionId"));
          break;
        case "computer.screenshot": {
          const shot = await this.desktop.screenshot();
          images = [shot];
          data = { captured: true };
          break;
        }
        case "computer.click":
          data = await this.desktop.click(
            number(a.x, 0),
            number(a.y, 0),
            a.button === "right" ? "right" : "left",
          );
          break;
        case "computer.type":
          data = await this.desktop.type(text(a.text, "text"));
          break;
        case "computer.key":
          data = await this.desktop.key(text(a.key, "key"));
          break;
        case "computer.scroll":
          data = await this.desktop.scroll(number(a.deltaY, 0));
          break;
        case "computer.open_app":
          data = await this.desktop.openApp(text(a.name, "name"));
          break;
        case "workspace.prepare":
          data = await this.prepareWorkspace(
            text(a.workspaceId, "workspaceId"),
            ((a.archiveUrls as unknown[]) ?? []).map(String),
            text(a.sha256, "sha256"),
          );
          break;
        case "workspace.collect":
          data = await this.collectWorkspace(
            text(a.workspaceId, "workspaceId"),
          );
          break;
        case "workspace.cleanup":
          data = await this.cleanupWorkspace(
            text(a.workspaceId, "workspaceId"),
          );
          break;
        default:
          throw new Error(`unimplemented node tool: ${call.name}`);
      }
      const rendered = typeof data === "string" ? data : JSON.stringify(data);
      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        text: rendered.slice(-120_000),
        data,
        images,
      };
    } catch (error) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        text: error instanceof Error ? error.message : String(error),
        images: [],
      };
    }
  }
  private workspacePath(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new Error("invalid workspaceId");
    }
    return path.join(this.workspaceRoot, id);
  }
  private async mustRun(argv: string[], cwd?: string) {
    const result = await runProcess(argv, { cwd, timeoutMs: 600_000 });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || `${argv.join(" ")} failed: ${result.exitCode}`,
      );
    }
    return result;
  }
  private async prepareWorkspace(
    id: string,
    archiveUrls: string[],
    expectedSha256: string,
  ) {
    if (!this.token) throw new Error("workspace transfer token is unavailable");
    if (!archiveUrls.length) throw new Error("archiveUrls must not be empty");
    const directory = this.workspacePath(id);
    await mkdir(this.workspaceRoot, { recursive: true });
    try {
      await lstat(directory);
      throw new Error(`workspace already exists: ${id}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(directory);
    const archive = path.join(this.workspaceRoot, `.incoming-${id}.tar.gz`);
    const failures: string[] = [];
    let payload: Buffer | undefined;
    try {
      for (const rawUrl of archiveUrls) {
        try {
          const url = new URL(rawUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error(`unsupported protocol ${url.protocol}`);
          }
          const response = await fetch(url, {
            headers: { authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(120_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          payload = Buffer.from(await response.arrayBuffer());
          break;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (!payload)
        throw new Error(`workspace download failed: ${failures.join("; ")}`);
      const actualSha256 = createHash("sha256").update(payload).digest("hex");
      if (actualSha256 !== expectedSha256)
        throw new Error("workspace archive SHA-256 mismatch");
      await writeFile(archive, payload, { flag: "wx" });
      await this.mustRun(["tar", "-xzf", archive, "-C", directory]);
      await this.mustRun(["git", "init", "-q"], directory);
      await this.mustRun(
        ["git", "config", "user.name", "Nexus Workspace"],
        directory,
      );
      await this.mustRun(
        ["git", "config", "user.email", "workspace@nexus.local"],
        directory,
      );
      await this.mustRun(["git", "add", "-A"], directory);
      await this.mustRun(
        [
          "git",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "Nexus workspace baseline",
        ],
        directory,
      );
      return {
        workspaceId: id,
        path: directory,
        bytes: payload.length,
        sha256: actualSha256,
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(archive, { force: true });
    }
  }
  private async collectWorkspace(id: string) {
    const directory = this.workspacePath(id);
    await this.mustRun(["git", "add", "-A"], directory);
    const diff = await this.mustRun(
      ["git", "diff", "--cached", "--binary", "--full-index", "HEAD"],
      directory,
    );
    const status = await this.mustRun(["git", "status", "--short"], directory);
    return {
      workspaceId: id,
      path: directory,
      patch: diff.stdout,
      changed: Boolean(diff.stdout.trim()),
      status: status.stdout,
    };
  }
  private async cleanupWorkspace(id: string) {
    const directory = this.workspacePath(id);
    await rm(directory, { recursive: true, force: true });
    return { workspaceId: id, removed: true };
  }
  private async runCode(
    language: string,
    code: string,
    cwd?: string,
    timeoutMs = 120_000,
  ) {
    const direct: Record<string, string[]> = {
      python: ["python3", "-c", code],
      node: ["node", "-e", code],
      bash: ["bash", "-lc", code],
      ruby: ["ruby", "-e", code],
    };
    if (direct[language])
      return runProcess(direct[language]!, { cwd, timeoutMs });
    if (!["go", "rust"].includes(language))
      throw new Error(`unsupported language: ${language}`);
    const dir = await mkdtemp(path.join(os.tmpdir(), "nexus-code-"));
    try {
      if (language === "go") {
        const file = path.join(dir, "main.go");
        await writeFile(file, code);
        return runProcess(["go", "run", file], { cwd: cwd ?? dir, timeoutMs });
      }
      const file = path.join(dir, "main.rs"),
        bin = path.join(dir, "main");
      await writeFile(file, code);
      const compile = await runProcess(["rustc", file, "-O", "-o", bin], {
        cwd: dir,
        timeoutMs,
      });
      if (compile.exitCode !== 0) return compile;
      return runProcess([bin], { cwd: cwd ?? dir, timeoutMs });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private async readDocument(file: string, maxBytes: number) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".pdf" && (await commandExists("pdftotext")))
      return runProcess(["pdftotext", file, "-"], { timeoutMs: 60_000 });
    if (
      [".docx", ".odt", ".rtf"].includes(ext) &&
      (await commandExists("pandoc"))
    )
      return runProcess(["pandoc", "-t", "plain", file], { timeoutMs: 60_000 });
    const buffer = (await readFile(file)).subarray(
      0,
      Math.max(1, Math.min(maxBytes, 5_000_000)),
    );
    if (buffer.includes(0))
      throw new Error(
        `binary document ${ext || "unknown"} needs pdftotext/pandoc or a future native parser`,
      );
    return { path: file, content: buffer.toString("utf8") };
  }
}
