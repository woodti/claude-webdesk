import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  realpath,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { applyClaudeEvent } from "./protocol.js";
import { fileURLToPath } from "node:url";
import { UUID } from "./history.js";
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
// Large logs stay on disk; memory keeps only list metadata for finished tasks.
const summary = ({ events, raw, output, _streamed, ...item }) => item;
export function buildArgs(input) {
  const args = ["--print", "--verbose", "--output-format", "stream-json",
    "--include-partial-messages", "--permission-mode", input.permissionMode,
    "--permission-prompts", "none"];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.maxBudgetUsd) args.push("--max-budget-usd", String(input.maxBudgetUsd));
  for (const dir of input.contextPaths) args.push("--add-dir", dir);
  if (input.resumeId) args.push("--resume", input.resumeId);
  if (input.forkSession) args.push("--fork-session");
  return args;
}

export class Tasks extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.items = new Map();
    this.active = null;
    this.starting = false;
    this.writes = Promise.resolve();
  }
  async init() {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.options.dataDir)) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const file = path.join(this.options.dataDir, name);
      let item;
      try {
        item = JSON.parse(await readFile(file, "utf8"));
        if (!item || typeof item.startedAt !== "string") throw new Error("missing startedAt");
      } catch (e) {
        // One damaged record must not prevent the service from starting.
        console.error(`Skipping unreadable task record ${name}: ${e.message}`);
        await rename(file, `${file}.corrupt`).catch(() => {});
        continue;
      }
      if (!UUID.test(item.id)) continue;
      if (["running", "stopping"].includes(item.status)) {
        item.status = "interrupted";
        item.error = "服务重启，任务未完成";
        item.endedAt = new Date().toISOString();
        await this.save(item);
      }
      this.items.set(item.id, summary(item));
    }
  }
  list() {
    return [...this.items.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(summary);
  }
  async get(id) {
    if (!this.items.has(id)) return null;
    if (this.active?.item.id === id) return this.active.item;
    await this.writes.catch(() => {});
    try {
      return JSON.parse(
        await readFile(path.join(this.options.dataDir, `${id}.json`), "utf8"),
      );
    } catch {
      throw new HttpError(500, "任务记录读取失败");
    }
  }
  save(item) {
    const snapshot = JSON.stringify(item);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.options.dataDir, `${item.id}.json`);
        await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    return this.writes;
  }
  async validate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new HttpError(400, "参数必须为对象");
    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      input.prompt.length > 50000
    )
      throw new HttpError(400, "Prompt 必须为 1–50000 个字符");
    const result = {
      prompt: input.prompt.trim(),
      cwd: input.cwd || this.options.cwd,
      model: input.model || "",
      effort: input.effort || "",
      permissionMode: input.permissionMode || "plan",
      maxBudgetUsd: input.maxBudgetUsd ?? null,
      forkSession: input.forkSession ?? false,
      contextPaths: input.contextPaths || [],
      resumeId: input.resumeId || "",
    };
    for (const field of ["cwd", "model", "effort", "permissionMode", "resumeId"])
      if (typeof result[field] !== "string")
        throw new HttpError(400, `${field} 必须是字符串`);
    if (
      result.model.length > 120 ||
      result.model.startsWith("-") ||
      /[\s\x00-\x1f]/.test(result.model)
    )
      throw new HttpError(400, "模型名称无效");
    if (!["", "low", "medium", "high", "xhigh", "max"].includes(result.effort))
      throw new HttpError(400, "推理强度无效");
    if (!["plan", "acceptEdits", "dontAsk"].includes(result.permissionMode))
      throw new HttpError(400, "权限模式无效");
    if (result.maxBudgetUsd !== null && (typeof result.maxBudgetUsd !== "number" ||
        !Number.isFinite(result.maxBudgetUsd) || result.maxBudgetUsd <= 0 || result.maxBudgetUsd > 1000))
      throw new HttpError(400, "预算必须是 0–1000 之间的美元金额");
    if (typeof result.forkSession !== "boolean" || (result.forkSession && !result.resumeId))
      throw new HttpError(400, "分叉会话需要先选择要继续的会话");
    if (result.resumeId && !UUID.test(result.resumeId))
      throw new HttpError(400, "会话 ID 无效");
    if (
      !Array.isArray(result.contextPaths) ||
      result.contextPaths.length > 8 ||
      result.contextPaths.some((v) => typeof v !== "string")
    )
      throw new HttpError(400, "最多 8 个上下文目录");
    const directory = async (value) => {
      if (!path.isAbsolute(value) || value.includes("\0"))
        throw new HttpError(400, "请使用绝对目录路径");
      let target;
      try {
        target = await realpath(value);
        if (!(await stat(target)).isDirectory()) throw new Error();
      } catch {
        throw new HttpError(400, `目录不存在：${value}`);
      }
      if (this.options.workspaceRoot) {
        const root = await realpath(this.options.workspaceRoot);
        const rel = path.relative(root, target);
        if (
          rel === ".." ||
          rel.startsWith(`..${path.sep}`) ||
          path.isAbsolute(rel)
        )
          throw new HttpError(403, "目录超出 workspace-root");
      }
      return target;
    };
    result.cwd = await directory(result.cwd);
    result.contextPaths = await Promise.all(result.contextPaths.map(directory));
    return result;
  }
  async start(input) {
    if (this.closing) throw new HttpError(503, "服务正在关闭");
    if (this.active || this.starting)
      throw new HttpError(409, "已有任务正在执行");
    this.starting = true;
    let unlock;
    this.startDone = new Promise((resolve) => {
      unlock = resolve;
    });
    try {
      const params = await this.validate(input);
      if (this.closing) throw new HttpError(503, "服务正在关闭");
      const item = {
        id: randomUUID(),
        ...params,
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        signal: null,
        events: [],
        raw: "",
        output: "",
        threadId: null,
      };
      await this.save(item);
      this.items.set(item.id, item);
      if (this.closing) {
        item.status = "interrupted";
        item.endedAt = new Date().toISOString();
        await this.save(item);
        throw new HttpError(503, "服务正在关闭");
      }
      const env = { ...process.env, CLAUDE_CONFIG_DIR: this.options.claudeHome };
      // Access tokens are for this server only; never pass them into Claude/model-launched shells.
      delete env.CLAUDE_REMOTE_WEB_TOKEN;
      delete env.CLAUDE_WEBDESK_TOKEN;
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const args = this.options.demo
        ? [fileURLToPath(new URL("./demo-cli.js", import.meta.url)), ...buildArgs(params)]
        : buildArgs(params);
      const child = spawn(this.options.claudeBin, args, {
        cwd: params.cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const active = { child, item, timer: null, persistTimer: null };
      this.active = active;
      let finished = false,
        pending = "",
        eventBytes = 0;
      const outDecoder = new StringDecoder("utf8"),
        errDecoder = new StringDecoder("utf8");
      const append = (type, data) => {
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (
          type !== "status" &&
          (item.events.length >= 20000 || eventBytes + bytes > 8_000_000)
        ) {
          item.truncated = true;
          return;
        }
        eventBytes += bytes;
        const event = { seq: item.events.length + 1, type, data };
        item.events.push(event);
        this.emit(item.id, event);
        if (!active.persistTimer)
          active.persistTimer = setTimeout(() => {
            active.persistTimer = null;
            this.save(item).catch((e) => this.emit("storageError", e));
          }, 3000);
      };
      const raw = (stream, text) => {
        if (!text) return;
        const room = 4_000_000 - item.raw.length;
        if (room <= 0) {
          item.truncated = true;
          return;
        }
        text = text.slice(0, room);
        item.raw += text;
        append("raw", { stream, text });
      };
      const line = (text) => {
        try {
          const event = JSON.parse(text);
          append("claude", event);
          applyClaudeEvent(item, event);
        } catch {
          /* non-JSON stdout remains in raw */
        }
      };
      child.stdout.on("data", (buffer) => {
        const text = outDecoder.write(buffer);
        raw("stdout", text);
        pending += text;
        let index;
        while ((index = pending.indexOf("\n")) !== -1) {
          line(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
        if (pending.length > 4_000_000) {
          pending = "";
          item.truncated = true;
        }
      });
      child.stderr.on("data", (buffer) =>
        raw("stderr", errDecoder.write(buffer)),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(params.prompt);
      child.on("error", (error) => {
        item.error =
          error.code === "ENOENT"
            ? "找不到 Claude CLI，请先安装或指定 --claude-bin"
            : error.message;
      });
      child.on("close", async (code, signal) => {
        if (finished) return;
        finished = true;
        raw("stdout", outDecoder.end());
        raw("stderr", errDecoder.end());
        if (pending.trim()) line(pending);
        clearTimeout(active.timer);
        clearTimeout(active.persistTimer);
        item.exitCode = code;
        item.signal = signal;
        item.endedAt = new Date().toISOString();
        item.status =
          item.status === "stopping"
            ? "interrupted"
            : code === 0 && !item.error
              ? "completed"
              : "failed";
        this.active = null;
        append("status", {
          status: item.status,
          exitCode: code,
          error: item.error,
        });
        clearTimeout(active.persistTimer);
        try {
          await this.save(item);
        } catch (e) {
          this.emit("storageError", e);
        }
        if (this.items.get(item.id) === item) this.items.set(item.id, summary(item));
      });
      return item;
    } finally {
      this.starting = false;
      unlock();
    }
  }
  stop(id, signal = "SIGINT") {
    const active = this.active;
    if (!active || active.item.id !== id)
      throw new HttpError(409, "任务已结束");
    if (!["SIGINT", "SIGTERM"].includes(signal))
      throw new HttpError(400, "无效信号");
    active.item.status = "stopping";
    this.signal(active.child, signal);
    if (!active.timer)
      active.timer = setTimeout(
        () => this.signal(active.child, "SIGKILL"),
        4000,
      );
    return { status: "stopping" };
  }
  signal(child, signal) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  async close() {
    this.closing = true;
    await this.startDone;
    if (this.active) {
      const active = this.active;
      const done = new Promise((resolve) =>
        active.child.once("close", resolve),
      );
      this.stop(active.item.id, "SIGTERM");
      await done;
    }
    await this.writes;
  }
}
