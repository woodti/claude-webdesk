import { applyClaudeEvent } from "../src/protocol.js";
import { initializeFiles, browseFiles } from "./files.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
let api, host;
export function disconnectWorkbench() {
  state.controller?.abort();
  state.activeId = null;
}
const $ = (id) => document.getElementById(id);
const state = {
  mode: "web",
  tasks: [],
  sessions: [],
  selected: null,
  activeId: null,
  resumeId: "",
  current: null,
  controller: null,
  viewing: 0,
  rawOpen: false,
};
// Finished task records never change, so earlier turns of a thread are fetched once.
const details = new Map();
const terminal = new Terminal({
  convertEol: true,
  disableStdin: true,
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  scrollback: 8000,
  theme: { background: "#151d24", foreground: "#d9e3e8" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
const labels = {
  idle: "空闲",
  running: "运行中",
  stopping: "正在中断",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
const permissions = { plan: "Plan", acceptEdits: "可编辑", dontAsk: "Don’t ask" };
const running = (item) => ["running", "stopping"].includes(item?.status);
const emptyState = $("turn").firstElementChild.cloneNode(true);
const SETTINGS = "claude-webdesk:settings";
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
const basename = (value = "") => value.replace(/\/+$/, "").split("/").pop() || value;
const firstLine = (text = "") => text.trim().split("\n")[0].slice(0, 80);
function when(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function duration(ms) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function notice(message) {
  $("notice").hidden = !message;
  $("notice").textContent = message;
}
function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e.name !== "AbortError") notice(e.message);
    }
  };
}
function showLogin() {
  state.controller?.abort();
  host.onSessionExpired();
}
function status(value) {
  $("status").className = `status ${value}`;
  $("status").textContent = `● ${labels[value] || value}`;
}
function controls() {
  $("run").disabled = !!state.activeId;
  $("run").hidden = !!state.activeId;
  $("stop").disabled = !state.activeId;
  $("stop").hidden = !state.activeId;
  $("presets").hidden = !!state.resumeId;
  $("follow-up").hidden =
    !!state.resumeId ||
    state.mode !== "web" ||
    !state.current?.threadId ||
    running(state.current);
}
function autosize() {
  const prompt = $("prompt");
  prompt.style.height = "auto";
  prompt.style.height = `${prompt.scrollHeight}px`;
}
function setPrompt(text) {
  $("prompt").value = text;
  autosize();
}
function settingsChip() {
  const parts = [
    `⚙ ${basename($("cwd").value) || "未设置目录"}`,
    $("model").value.trim() || "默认模型",
    permissions[$("permission-mode").value],
  ];
  if ($("effort").value) parts.push($("effort").value);
  if ($("budget").value) parts.push(`$${$("budget").value}`);
  $("settings-toggle").textContent = parts.join(" · ");
}
function toggleSettings(open = $("task-settings").hidden) {
  $("task-settings").hidden = !open;
  $("settings-toggle").setAttribute("aria-expanded", String(open));
}
function rememberSettings() {
  try {
    localStorage.setItem(
      SETTINGS,
      JSON.stringify({
        model: $("model").value,
        effort: $("effort").value,
        permissionMode: $("permission-mode").value,
        budget: $("budget").value,
      }),
    );
  } catch {
    /* Preferences are a convenience only. */
  }
}
function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS) || "{}");
    $("model").value = saved.model || "";
    $("effort").value = saved.effort || "";
    if (permissions[saved.permissionMode]) $("permission-mode").value = saved.permissionMode;
    $("budget").value = saved.budget || "";
  } catch {
    /* Ignore unavailable or malformed storage. */
  }
}
function markdown(text) {
  const div = document.createElement("div");
  div.className = "markdown";
  div.innerHTML = DOMPurify.sanitize(marked.parse(text), {
    FORBID_TAGS: ["img", "style", "form", "input"],
  });
  for (const code of div.querySelectorAll("pre code")) {
    hljs.highlightElement(code);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "复制";
    button.addEventListener(
      "click",
      guarded(async () => {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = "已复制";
      }),
    );
    code.parentElement.prepend(button);
  }
  return div;
}
// Text up to the last blank line outside a code fence will not change while streaming.
function stableLength(text) {
  let fenced = false,
    stable = 0,
    offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    offset += line.length + 1;
    if (!fenced && !line.trim() && offset <= text.length) stable = offset;
  }
  return stable;
}
// Render streaming Markdown incrementally so long answers are not reparsed every frame.
const answer = { id: null, source: "", node: null, tail: null };
function answerNode(item) {
  if (answer.id !== item.id || !item.output.startsWith(answer.source)) {
    answer.id = item.id;
    answer.source = "";
    answer.node = document.createElement("div");
    answer.tail = document.createElement("div");
    answer.node.className = "answer";
    answer.node.append(answer.tail);
  }
  const stable = item.output.slice(0, stableLength(item.output));
  if (stable.length > answer.source.length) {
    answer.node.insertBefore(markdown(stable.slice(answer.source.length)), answer.tail);
    answer.source = stable;
  }
  const tail = item.output.slice(answer.source.length);
  if (answer.tail.dataset.source !== tail) {
    answer.tail.replaceChildren(...(tail.trim() ? [markdown(tail)] : []));
    answer.tail.dataset.source = tail;
  }
  return answer.node;
}
// Move only nodes that are out of place, so selections and open <details> survive live updates.
function sync(container, nodes) {
  const wanted = new Set(nodes);
  for (const child of [...container.childNodes]) if (!wanted.has(child)) child.remove();
  let ref = container.firstChild;
  for (const node of nodes) {
    if (node === ref) ref = ref.nextSibling;
    else container.insertBefore(node, ref);
  }
}
function bubble(text, time) {
  const box = el("div", "bubble");
  const meta = el("div", "bubble-meta");
  meta.append(el("span", "", time));
  const reuse = el("button", "", "复用指令");
  reuse.type = "button";
  reuse.title = "把这条指令放回输入框";
  reuse.addEventListener("click", () => {
    setPrompt(text);
    $("prompt").focus();
  });
  meta.append(reuse);
  box.append(el("div", "text", text), meta);
  return box;
}
function toolTarget(input = {}) {
  const value =
    input.file_path || input.path || input.command || input.pattern || input.url ||
    input.query || input.description || input.prompt || "";
  return String(value).split("\n")[0].slice(0, 160);
}
function toolNode(tool) {
  const node = el("details", "activity");
  const summary = el("summary");
  summary.append(el("b", "", tool.name));
  const target = toolTarget(tool.input);
  if (target) summary.append(el("code", "", target));
  node.append(summary, el("pre", "", JSON.stringify(tool.input ?? {}, null, 2)));
  return node;
}
// One node per tool call or lifecycle event, keyed so live renders reuse them.
function activities(item, cache) {
  const nodes = [];
  for (const event of item.events || []) {
    if (event.type !== "claude") continue;
    const data = event.data;
    if (["stream_event", "user", "result"].includes(data.type)) continue;
    if (data.type === "assistant") {
      (data.message?.content || [])
        .filter((b) => b.type === "tool_use")
        .forEach((tool, i) => {
          const key = `${event.seq}:${i}`;
          if (!cache.has(key)) cache.set(key, toolNode(tool));
          nodes.push(cache.get(key));
        });
      continue;
    }
    if (!cache.has(event.seq))
      cache.set(
        event.seq,
        el(
          "div",
          "activity line",
          data.type === "system" && data.subtype === "init"
            ? `会话已开始${data.model ? ` · ${data.model}` : ""}`
            : `${data.type}${data.subtype ? ` · ${data.subtype}` : ""}`,
        ),
      );
    nodes.push(cache.get(event.seq));
  }
  return nodes;
}
function turnMeta(item) {
  if (running(item) || !item.endedAt) return null;
  const parts = [labels[item.status] || item.status];
  if (item.turns) parts.push(`${item.turns} turns`);
  if (item.durationMs) parts.push(duration(item.durationMs));
  if (item.costUsd != null) parts.push(`$${Number(item.costUsd).toFixed(4)}`);
  if (item.exitCode) parts.push(`exit ${item.exitCode}`);
  return el("div", "turn-meta", parts.join(" · "));
}
function extras(item) {
  const nodes = [];
  if (item.permissionDenials?.length)
    nodes.push(
      el(
        "p",
        "notice",
        "Claude 需要额外权限的工具被拒绝：" +
          item.permissionDenials.map((d) => d.tool_name).join(", ") +
          "。可在设置中切换执行权限后重试。",
      ),
    );
  if (item.error) nodes.push(el("div", "activity error", item.error));
  if (item.truncated) nodes.push(el("p", "notice", "输出已达到保留上限，当前显示为截断记录。"));
  return nodes;
}
// A finished, earlier turn of the current conversation.
function pastTurn(item) {
  const block = el("div", "turn-block past");
  block.append(bubble(item.prompt || "", when(item.startedAt)));
  const tools = activities(item, new Map()).filter((n) => n.tagName === "DETAILS");
  if (tools.length) {
    const group = el("details", "activity");
    const summary = el("summary");
    summary.append(el("b", "", `${tools.length} 次工具调用`));
    const list = el("div", "tools");
    list.style.padding = "4px 8px 8px";
    list.append(...tools);
    group.append(summary, list);
    block.append(group);
  }
  if (item.output) block.append(el("div", "role", "Claude"), markdown(item.output));
  block.append(...extras(item));
  const meta = turnMeta(item);
  if (meta) block.append(meta);
  return block;
}
const view = { id: null, bubble: null, tools: el("div", "tools"), role: el("div", "role", "Claude"), cache: new Map(), working: null };
function workingNode() {
  if (!view.working) {
    view.working = el("div", "working");
    view.working.append(el("i"), el("i"), el("i"), el("span", "", "Claude 正在工作…"));
  }
  return view.working;
}
setInterval(() => {
  const item = state.current;
  if (!view.working?.isConnected || !running(item)) return;
  const seconds = Math.round((Date.now() - Date.parse(item.startedAt)) / 1000);
  view.working.lastChild.textContent = `Claude 正在工作… ${duration(seconds * 1000) || "0s"}`;
}, 1000);
function renderMetrics(item) {
  const metrics = $("metrics");
  const usage = item.usage || {};
  metrics.hidden = item.costUsd == null && Object.keys(usage).length === 0;
  metrics.textContent = `USD ${item.costUsd == null ? "—" : Number(item.costUsd).toFixed(4)}  ·  Input ${(usage.input_tokens || 0).toLocaleString()}  ·  Output ${(usage.output_tokens || 0).toLocaleString()}  ·  Cache ${(usage.cache_read_input_tokens || 0).toLocaleString()}  ·  ${item.turns || 0} turns`;
}
function renderOutput(item) {
  renderMetrics(item);
  const output = $("structured");
  const turn = $("turn");
  const nearBottom =
    output.scrollHeight - output.scrollTop - output.clientHeight < 120;
  const previous = output.scrollTop;
  if (item.messages) {
    const nodes = [];
    for (const message of item.messages) {
      if (message.role === "user") {
        nodes.push(bubble(message.text, message.time || ""));
        continue;
      }
      const block = el("div", "turn-block");
      block.append(el("div", "role", `Claude${message.time ? ` · ${message.time}` : ""}`), markdown(message.text));
      nodes.push(block);
    }
    turn.replaceChildren(...nodes);
  } else {
    if (view.id !== item.id) {
      view.id = item.id;
      view.cache = new Map();
      view.bubble = bubble(item.prompt || "", when(item.startedAt));
    }
    sync(view.tools, activities(item, view.cache).slice(-60));
    const nodes = [view.bubble, view.tools];
    if (item.output) nodes.push(view.role, answerNode(item));
    nodes.push(...extras(item));
    if (running(item)) nodes.push(workingNode());
    const meta = turnMeta(item);
    if (meta) nodes.push(meta);
    sync(turn, nodes);
  }
  output.scrollTop = nearBottom ? output.scrollHeight : previous;
}
function showEmpty() {
  $("thread").replaceChildren();
  $("turn").replaceChildren(emptyState.cloneNode(true));
  $("metrics").hidden = true;
  $("conv-title").textContent = "新对话";
  $("output-meta").textContent = "选择历史记录，或在下方写下任务";
  $("output-meta").title = "";
}
function loadFields(item) {
  $("cwd").value = item.cwd || $("cwd").value;
  $("model").value = item.model || "";
  $("effort").value = item.effort || "";
  $("budget").value = item.maxBudgetUsd || "";
  $("permission-mode").value = item.permissionMode || "plan";
  $("context-paths").value = (item.contextPaths || []).join("\n");
  settingsChip();
}
function setResume(id, title) {
  state.resumeId = id;
  $("fork-session").checked = false;
  $("resume-banner").hidden = !id;
  $("resume-label").textContent = `↪ 继续会话 · ${title || id}`;
  controls();
}
// Web tasks that continue a Claude session form one conversation.
function parentOf(task) {
  if (!task?.resumeId) return null;
  let best = null;
  for (const t of state.tasks)
    if (t.id !== task.id && t.threadId === task.resumeId && t.startedAt < task.startedAt &&
        (!best || t.startedAt > best.startedAt)) best = t;
  return best;
}
function ancestors(task) {
  const chain = [];
  for (let p = parentOf(task); p && chain.length < 20; p = parentOf(p)) chain.unshift(p);
  return chain;
}
function conversationTitle(task) {
  const root = ancestors(task)[0] || task;
  return firstLine(root.title || root.prompt) || "未命名对话";
}
function conversations() {
  const continued = new Set();
  for (const t of state.tasks) {
    const parent = !t.forkSession && parentOf(t);
    if (parent) continued.add(parent.id);
  }
  return state.tasks
    .filter((t) => !continued.has(t.id))
    .map((t) => {
      const chain = [...ancestors(t), t];
      return {
        ...t,
        title: conversationTitle(t),
        turns: chain.length,
        search: chain.map((c) => c.prompt).join(" "),
      };
    });
}
function dayGroup(value) {
  const day = new Date(value);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - new Date(day).setHours(0, 0, 0, 0)) / 86400000);
  return diff <= 0 ? "今天" : diff === 1 ? "昨天" : diff < 7 ? "近 7 天" : "更早";
}
function listHistory() {
  const query = $("search").value.trim().toLowerCase();
  const items = state.mode === "web" ? conversations() : state.sessions;
  const filtered = items.filter((item) =>
    `${item.title || item.prompt} ${item.search || ""} ${item.cwd} ${item.model}`
      .toLowerCase()
      .includes(query),
  );
  $("history-count").textContent =
    `${state.mode === "web" ? "对话" : "CLI 会话"} · ${filtered.length}`;
  const nodes = [];
  let group = "";
  for (const item of filtered) {
    const stamp = item.startedAt || item.updated;
    if (dayGroup(stamp) !== group) {
      group = dayGroup(stamp);
      nodes.push(el("div", "history-group", group));
    }
    const button = el("button", `history-item${state.selected === item.id ? " selected" : ""}`);
    button.title = `${item.title || item.prompt}\n${item.cwd}`;
    const subtitle = el("small");
    subtitle.append(
      el("i", `state-dot ${item.status || ""}`),
      el(
        "span",
        "",
        [
          item.status ? labels[item.status] : item.archived ? "归档" : "会话",
          item.turns > 1 ? `${item.turns} 轮` : "",
          new Date(stamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
          basename(item.cwd),
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    button.append(el("strong", "", item.title || firstLine(item.prompt)), subtitle);
    button.addEventListener(
      "click",
      guarded(async () => {
        $("workspace").classList.remove("nav-open");
        await select(item.id);
      }),
    );
    nodes.push(button);
  }
  if (!filtered.length)
    nodes.push(el("div", "history-empty", query ? "没有匹配的记录" : "还没有记录，发送第一个任务吧"));
  $("history-list").replaceChildren(...nodes);
}
async function refreshHistory() {
  if (state.mode === "web") state.tasks = (await api("/api/tasks")).tasks;
  else {
    $("history-count").textContent = "读取本地会话…";
    state.sessions = (await api("/api/sessions")).sessions;
  }
  listHistory();
}
function writeTerminal(text) {
  terminal.write(text.replace(/\r?\n/g, "\r\n"));
}
async function detail(task) {
  if (details.has(task.id)) return details.get(task.id);
  const item = await api(`/api/tasks/${task.id}`);
  if (!running(item)) details.set(task.id, item);
  return item;
}
async function select(id) {
  state.controller?.abort();
  const generation = ++state.viewing;
  const item = await api(
    `/api/${state.mode === "web" ? "tasks" : "sessions"}/${id}`,
  );
  const chain = state.mode === "web" ? await Promise.all(ancestors(item).map(detail)) : [];
  if (generation !== state.viewing) return;
  state.selected = id;
  state.current = item;
  loadFields(item);
  setPrompt("");
  notice("");
  const thread = chain.map(pastTurn);
  if (state.mode === "cli") {
    setResume(item.archived ? "" : id, item.title);
    status(state.activeId ? "running" : "idle");
    $("conv-title").textContent = item.title || "CLI 会话";
    $("output-meta").textContent =
      `CLI 会话 · ${basename(item.cwd)} · ${id.slice(0, 8)}${item.archived ? " · 已归档，仅供查看" : ""}`;
    $("output-meta").title = item.cwd;
  } else {
    const origin = (chain[0] || item).resumeId;
    if (origin && !chain.length)
      thread.unshift(el("div", "activity line", `接续会话 ${origin.slice(0, 8)} · 更早的上下文在 Claude 会话中`));
    setResume(
      !running(item) && item.threadId ? item.threadId : "",
      conversationTitle(item),
    );
    status(item.status);
    if (!running(item)) {
      if (state.activeId === item.id) state.activeId = null;
      const summary = state.tasks.find((task) => task.id === item.id);
      if (summary) summary.status = item.status;
      $("connection").textContent = "";
    }
    $("conv-title").textContent = conversationTitle(item);
    $("output-meta").textContent = [
      basename(item.cwd),
      item.model || "默认模型",
      permissions[item.permissionMode],
      chain.length ? `${chain.length + 1} 轮` : "",
      when(item.startedAt),
    ]
      .filter(Boolean)
      .join(" · ");
    $("output-meta").title = item.cwd;
  }
  $("thread").replaceChildren(...thread);
  $("turn").replaceChildren();
  renderOutput(item);
  $("structured").scrollTop = $("structured").scrollHeight;
  terminal.reset();
  if (item.raw) writeTerminal(item.raw);
  controls();
  listHistory();
  if (running(item)) stream(item);
}
// Tell users on another tab that a long task has finished.
const baseTitle = document.title;
function announce(item) {
  if (!document.hidden) return;
  const label = labels[item.status] || item.status;
  document.title = `${item.status === "completed" ? "✓" : "✕"} ${label} · ${baseTitle}`;
  if (window.Notification?.permission === "granted")
    new Notification(`Claude 任务${label}`, {
      body: (item.prompt || "").split("\n")[0].slice(0, 120),
      tag: item.id,
    });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) document.title = baseTitle;
});
// Once a task ends, the composer continues its conversation by default.
function finished(item) {
  renderOutput(item);
  status(item.status);
  if (!state.resumeId && item.threadId) setResume(item.threadId, conversationTitle(item));
  controls();
}
async function stream(item) {
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  let after = item.events.at(-1)?.seq || 0;
  while (!controller.signal.aborted) {
    try {
      $("connection").textContent = "● 正在连接…";
      const response = await fetch(
        `/api/tasks/${item.id}/events?after=${after}`,
        { signal: controller.signal },
      );
      if (response.status === 401) {
        showLogin();
        return;
      }
      if (!response.ok) throw new Error(`流式连接 HTTP ${response.status}`);
      $("connection").textContent = "● 实时连接";
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      let dirty = false,
        timer;
      const flush = () => {
        timer = null;
        if (dirty && state.current === item) {
          renderOutput(item);
          dirty = false;
        }
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const payload = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!payload) continue;
            const event = JSON.parse(payload.slice(6));
            if (controller.signal.aborted || state.current !== item) return;
            if (event.seq <= after) continue;
            after = event.seq;
            item.events.push(event);
            if (event.type === "raw") {
              writeTerminal(event.data.text);
              item.raw += event.data.text;
            }
            if (event.type === "claude") {
              const data = event.data;
              applyClaudeEvent(item, data);
            }
            if (event.type === "status") {
              Object.assign(item, event.data);
              status(item.status);
              if (state.activeId === item.id) state.activeId = null;
              controls();
              $("connection").textContent = "";
              const final = await api(`/api/tasks/${item.id}`);
              if (state.current !== item) return;
              Object.assign(item, final);
              finished(item);
              announce(item);
              await refreshHistory();
              return;
            }
            dirty = true;
            if (!timer) timer = setTimeout(flush, 150);
          }
        }
      } finally {
        clearTimeout(timer);
        flush();
        reader.releaseLock();
      }
      if (controller.signal.aborted) return;
      const current = await api(`/api/tasks/${item.id}`);
      if (!running(current)) {
        if (state.current !== item) return;
        Object.assign(item, current);
        state.activeId = null;
        finished(item);
        await refreshHistory();
        return;
      }
      throw new Error("连接断开");
    } catch (error) {
      if (controller.signal.aborted) return;
      $("connection").textContent = `● ${error.message}，正在重连`;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
export function showFiles(open = true) {
  $("file-browser").hidden = !open;
  if (open) browseFiles().catch(() => {});
}
export async function initializeWorkbench(config, context) {
  host = context;
  api = context.api;
  state.activeId = config.activeId;
  $("cwd").value = config.cwd;
  restoreSettings();
  settingsChip();
  $("demo-banner").hidden = !config.demo;
  await initializeFiles(api);
  if (!state.rawOpen) {
    terminal.open($("raw"));
    state.rawOpen = true;
    new ResizeObserver(() => {
      if (!$("raw").hidden) fit.fit();
    }).observe($("raw"));
  }
  controls();
  await refreshHistory();
  if (state.activeId) {
    state.mode = "web";
    await select(state.activeId);
  } else $("prompt").focus();
}
$("task-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    if (state.activeId) return;
    notice("");
    $("run").disabled = true;
    if (window.Notification?.permission === "default")
      Notification.requestPermission().catch(() => {});
    try {
      const item = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          prompt: $("prompt").value,
          cwd: $("cwd").value,
          model: $("model").value.trim(),
          effort: $("effort").value,
          permissionMode: $("permission-mode").value,
          maxBudgetUsd: $("budget").value ? Number($("budget").value) : null,
          forkSession: Boolean(state.resumeId && $("fork-session").checked),
          contextPaths: $("context-paths")
            .value.split("\n")
            .map((p) => p.trim())
            .filter(Boolean),
          resumeId: state.resumeId,
        }),
      });
      rememberSettings();
      toggleSettings(false);
      state.activeId = item.id;
      state.mode = "web";
      $("web-history").classList.add("selected");
      $("cli-history").classList.remove("selected");
      await refreshHistory();
      await select(item.id);
    } finally {
      controls();
    }
  }),
);
// Hidden required settings would otherwise block submit without any visible hint.
$("task-form").addEventListener(
  "invalid",
  (event) => {
    if (event.target.closest("#task-settings")) toggleSettings(true);
  },
  true,
);
$("prompt").addEventListener("input", autosize);
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("task-form").requestSubmit();
  }
});
for (const id of ["cwd", "model", "effort", "permission-mode", "budget"]) {
  $(id).addEventListener("input", settingsChip);
  $(id).addEventListener("change", settingsChip);
}
$("settings-toggle").addEventListener("click", () => toggleSettings());
const presets = {
  review:
    "请评审当前项目的代码。优先指出真实的正确性问题、安全问题和回归风险，给出文件位置、理由和修复建议。先阅读相关代码，仅做分析。",
  tests:
    "请分析当前项目的测试约定，为核心行为和边界条件补充有意义的单元测试，运行相关测试并报告结果。",
  debug:
    "请排查下面的问题，先核实根因，再给出最小修复方案与验证方法。\n\n错误信息：\n\n复现步骤：\n",
  refactor:
    "请分析当前项目，找出一处值得改善的重复或复杂代码，在保持现有行为的前提下进行小范围重构，运行相关检查并说明变化。",
};
for (const button of document.querySelectorAll("[data-preset]"))
  button.addEventListener("click", () => {
    setPrompt(presets[button.dataset.preset]);
    $("permission-mode").value = ["tests", "refactor"].includes(button.dataset.preset)
      ? "acceptEdits"
      : "plan";
    settingsChip();
    $("prompt").focus();
  });
$("cancel-resume").addEventListener("click", () => {
  setResume("", "");
  $("prompt").focus();
});
$("follow-up").addEventListener("click", () => {
  const item = state.current;
  if (!item?.threadId) return;
  setResume(item.threadId, conversationTitle(item));
  setPrompt("");
  $("prompt").focus();
});
$("stop").addEventListener(
  "click",
  guarded(async () => {
    if (!state.activeId) return;
    status("stopping");
    await api(`/api/tasks/${state.activeId}/stop`, {
      method: "POST",
      body: JSON.stringify({ signal: "SIGINT" }),
    });
  }),
);
$("new-task").addEventListener("click", () => {
  state.controller?.abort();
  state.viewing++;
  state.selected = null;
  state.current = null;
  view.id = null;
  setResume("", "");
  setPrompt("");
  notice("");
  showEmpty();
  terminal.reset();
  status(state.activeId ? "running" : "idle");
  controls();
  listHistory();
  $("workspace").classList.remove("nav-open");
  $("prompt").focus();
});
$("search").addEventListener("input", listHistory);
$("refresh").addEventListener("click", guarded(refreshHistory));
for (const [id, mode] of [
  ["web-history", "web"],
  ["cli-history", "cli"],
])
  $(id).addEventListener(
    "click",
    guarded(async () => {
      state.mode = mode;
      $("web-history").classList.toggle("selected", mode === "web");
      $("cli-history").classList.toggle("selected", mode === "cli");
      await refreshHistory();
    }),
  );
$("structured-tab").addEventListener("click", () => {
  $("structured").hidden = false;
  $("raw").hidden = true;
  $("structured-tab").classList.add("selected");
  $("raw-tab").classList.remove("selected");
});
$("raw-tab").addEventListener("click", () => {
  $("structured").hidden = true;
  $("raw").hidden = false;
  $("raw-tab").classList.add("selected");
  $("structured-tab").classList.remove("selected");
  fit.fit();
});
$("files-toggle").addEventListener("click", () => showFiles($("file-browser").hidden));
$("files-close").addEventListener("click", () => showFiles(false));
$("export").addEventListener(
  "click",
  guarded(async () => {
    const item = state.current;
    if (!item) return;
    const turns = item.messages
      ? item.messages.map((m) => `## ${m.role === "user" ? "你" : "Claude"}\n\n${m.text}`)
      : [...(await Promise.all(ancestors(item).map(detail))), item].map(
          (t) => `## 你 · ${when(t.startedAt)}\n\n${t.prompt}\n\n## Claude\n\n${t.output || t.error || ""}`,
        );
    const text = `# ${$("conv-title").textContent}\n\n${turns.join("\n\n---\n\n")}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-${item.id}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }),
);
// Keep the global run/stop controls correct even while browsing another historical session.
setInterval(async () => {
  if ($("workspace").hidden || !state.activeId) return;
  try {
    const config = await api("/api/config");
    if (!config.activeId) {
      state.activeId = null;
      controls();
      await refreshHistory();
    }
  } catch {
    /* surfaced by stream or next action */
  }
}, 4000);

export async function resumeSession(id) {
  state.mode = "cli";
  $("cli-history").classList.add("selected");
  $("web-history").classList.remove("selected");
  await refreshHistory();
  await select(id);
  setPrompt("请结合上述会话，继续尚未完成的工作。");
  $("prompt").focus();
}
