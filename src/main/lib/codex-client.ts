import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface CodexEvent {
  method: string;
  params: {
    threadId?: string;
    loginId?: string;
    success?: boolean;
    item?: { id: string; type: string; status?: string; result?: string; failure?: { type: string } };
    turn?: { id: string; status: string; error?: { codexErrorInfo?: unknown } };
  };
}

const sessions = new Set<CodexClient>();
export async function closeCodexSessions() { await Promise.allSettled([...sessions].map((client) => client.dispose())); }

export class CodexCompatibilityError extends Error {
  constructor() { super("This ChatGPT connection is not compatible with MōIcons. Update the ChatGPT desktop app, then try again."); }
}

const fallbackBinPaths = ["/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local/bin")];

export async function findCodex(): Promise<string | undefined> {
  // Finder-launched apps usually have a much smaller PATH than a terminal.
  const candidates = process.env.MOICONS_CODEX_PATH ? [process.env.MOICONS_CODEX_PATH] : [
    ...["/Applications", path.join(homedir(), "Applications")].flatMap((root) =>
      ["ChatGPT.app", "Codex.app"].map((app) => path.join(root, app, "Contents/Resources/codex"))),
    ...[...(process.env.PATH || "").split(path.delimiter), ...fallbackBinPaths]
      .filter(Boolean).map((dir) => path.join(dir, "codex")),
  ];
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next installation. */ }
  }
}

/** A private stdio session. No shell, copied credentials, or global config writes. */
export class CodexClient {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: CodexEvent) => void>();
  private failures = new Set<(error: Error) => void>();
  private closed = false;
  private buffer = "";
  private child: ChildProcessWithoutNullStreams;
  private disposing?: Promise<void>;
  private constructor(readonly cwd: string, executable: string) {
    sessions.add(this);
    const env = { ...process.env };
    // npm CLI launchers use /usr/bin/env node, including when launched from Finder.
    env.PATH = [...new Set([path.dirname(executable), ...(env.PATH || "").split(path.delimiter),
      ...fallbackBinPaths].filter(Boolean))].join(path.delimiter);
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const overrides = {
      "features.shell_tool": false, "features.unified_exec": false,
      "features.apps": false, "features.plugins": false, "features.multi_agent": false,
      "features.memories": false, "features.image_generation": true,
      web_search: "disabled",
    };
    this.child = spawn(executable, ["app-server", "--listen", "stdio://",
      ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    ], { cwd, env, stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Server logs can contain private prompts or account data. Drain without logging.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail(new Error("The connection to ChatGPT was lost. Try again.")));
    this.child.on("error", () => this.fail(new Error("Could not start the ChatGPT connection. Update or reinstall the ChatGPT desktop app, then try again.")));
    this.child.on("exit", () => this.fail(new Error("The ChatGPT connection stopped unexpectedly. Update the ChatGPT desktop app and try again.")));
  }

  static async start(): Promise<CodexClient> {
    const executable = await findCodex();
    if (!executable) throw new Error("Install the ChatGPT desktop app on this Mac, then check again.");
    const cwd = await mkdtemp(path.join(tmpdir(), "moicons-codex-"));
    const client = new CodexClient(cwd, executable);
    try {
      await client.request("initialize", {
        clientInfo: { name: "moicons", title: "MōIcons", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      client.send({ method: "initialized", params: {} });
      return client;
    } catch (error) { await client.dispose(); throw error; }
  }

  request<T>(method: string, params: unknown, timeout = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The connection to ChatGPT was closed. Try again."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ChatGPT did not respond in time. Try again."));
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ id, method, params });
    });
  }

  subscribe(listener: (event: CodexEvent) => void, onFailure: (error: Error) => void) {
    this.listeners.add(listener);
    this.failures.add(onFailure);
    return () => { this.listeners.delete(listener); this.failures.delete(onFailure); };
  }

  private send(value: unknown) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 40 * 1024 * 1024) {
      this.fail(new Error("ChatGPT returned an image that is too large."));
      this.child.kill();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        this.fail(new CodexCompatibilityError());
        return;
      }
      if (message.method && message.id !== undefined) {
        // Never grant permissions or run client tools on behalf of an image prompt.
        this.send({ id: message.id, error: { code: -32601, message: "MōIcons does not support client tools or approval requests." } });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject([-32601, -32602].includes(message.error.code)
          ? new CodexCompatibilityError()
          : new Error("ChatGPT could not complete this request. Check your ChatGPT sign-in and try again."));
        else pending.resolve(message.result);
      } else if (message.method && message.params) {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
  }

  dispose(): Promise<void> {
    return this.disposing ??= this.disposeSession();
  }

  private async disposeSession() {
    sessions.delete(this);
    this.fail(new Error("The connection to ChatGPT was closed."));
    this.listeners.clear();
    this.failures.clear();
    this.child.stdin.end();
    // Reap the child before deleting any reference images it may still be using.
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.child.kill("SIGKILL"); }, 2_000);
        this.child.once("exit", () => { clearTimeout(timer); resolve(); });
        this.child.kill("SIGTERM");
      });
    }
    await rm(this.cwd, { recursive: true, force: true });
  }
}
