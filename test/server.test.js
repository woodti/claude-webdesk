import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { buildArgs } from "../src/tasks.js";
const bin = fileURLToPath(new URL("./fake-claude.js", import.meta.url));
const token = "test-token-with-enough-entropy-123456";
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-remote-web-"));
  const home = path.join(root, "claude");
  await mkdir(home);
  const opts = {
    cwd: root,
    claudeHome: home,
    dataDir: path.join(root, "data"),
    claudeBin: bin,
    token,
    ...extra,
  };
  const app = await createServer(opts);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = (route, init = {}) =>
    fetch(url + route, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  return { ...app, root, home, url, request, opts };
}
async function completed(app, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const item = app.tasks.items.get(id);
    if (!["running", "stopping"].includes(item.status)) {
      await app.tasks.writes;
      return app.tasks.get(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not complete");
}
test("all data routes require authentication; login issues an HttpOnly cookie", async (t) => {
  const app = await fixture(t);
  for (const route of ["/api/config", "/api/tasks", "/api/sessions"])
    assert.equal((await fetch(app.url + route)).status, 401);
  assert.equal((await fetch(app.url + "/?token=wrong")).status, 200);
  const login = await fetch(app.url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(
    (await fetch(app.url + "/api/config", { headers: { Cookie: cookie } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(app.url + "/api/logout", {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(app.url + "/api/logout", {
        method: "POST",
        headers: { Cookie: cookie, Origin: app.url },
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(app.url + "/api/config", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
});
test("cross-origin requests are rejected and invalid logins are rate limited", async (t) => {
  const app = await fixture(t);
  assert.equal(
    (
      await app.request("/api/tasks", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await fetch(app.url + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"token":"wrong"}',
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await fetch(app.url + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
    ).status,
    429,
  );
});
test("input validation rejects unsafe flags and missing directories", async (t) => {
  const app = await fixture(t);
  for (const input of [
    { prompt: "" },
    { prompt: "hi", model: "--evil" },
    { prompt: "hi", permissionMode: "bypassPermissions" },
    { prompt: "hi", cwd: "/not-here" },
    { prompt: "hi", contextPaths: ["relative"] },
    { prompt: "hi", effort: "invented" },
    { prompt: "hi", resumeId: "not-a-uuid" },
  ]) {
    assert.equal(
      (
        await app.request("/api/tasks", {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).status,
      400,
    );
  }
});
test("spawn streams JSON events, keeps ANSI, persists output and does not shell-expand prompts", async (t) => {
  const app = await fixture(t);
  const prompt = "literal $(touch /tmp/should-not-exist) `echo unsafe` 中文";
  process.env.CLAUDE_REMOTE_WEB_TOKEN = "must-not-leak";
  process.env.CLAUDE_WEBDESK_TOKEN = "new-must-not-leak";
  t.after(() => delete process.env.CLAUDE_WEBDESK_TOKEN);
  t.after(() => delete process.env.CLAUDE_REMOTE_WEB_TOKEN);
  const response = await app.request("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      cwd: app.root,
      model: "custom-model",
      effort: "high",
    }),
  });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const stream = await app.request(`/api/tasks/${id}/events`);
  const text = await stream.text();
  assert.match(text, /stream_event/);
  assert.match(text, /"type":"status"/);
  const item = await completed(app, id);
  assert.equal(item.status, "completed");
  assert.match(item.raw, /\x1b\[32m/);
  assert.match(item.output, /const answer/);
  const args = item.events.find((e) => e.data?.type === "test.args").data;
  assert.equal(args.prompt, prompt);
  assert.equal(args.serverToken, null);
  assert.ok(args.args.includes("stream-json"));
  const saved = JSON.parse(
    await readFile(path.join(app.opts.dataDir, `${id}.json`), "utf8"),
  );
  assert.equal(saved.output, item.output);
  const resumed = await app.request(
    `/api/tasks/${id}/events?after=${item.events.at(-1).seq}`,
  );
  assert.equal(await resumed.text(), "");
});
test("single task lock and SIGINT stop the complete process group", async (t) => {
  const app = await fixture(t);
  const item = await app.tasks.start({ prompt: "slow" });
  await assert.rejects(
    app.tasks.start({ prompt: "another" }),
    (e) => e.status === 409,
  );
  const deadline = Date.now() + 3000;
  while (
    !item.events.some((e) => e.data?.type === "test.child") &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  const pid = item.events.find((e) => e.data?.type === "test.child").data.pid;
  assert.equal(
    (
      await app.request(`/api/tasks/${item.id}/stop`, {
        method: "POST",
        body: '{"signal":"SIGINT"}',
      })
    ).status,
    200,
  );
  const final = await completed(app, item.id);
  assert.equal(final.status, "interrupted");
  // Linux can briefly retain a dead child as a zombie; it must not still run.
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.equal(stat.split(" ")[2], "Z");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
});
test("failed CLI and missing CLI become reviewable failed tasks", async (t) => {
  const app = await fixture(t);
  const failed = await app.tasks.start({ prompt: "fail" });
  assert.equal((await completed(app, failed.id)).status, "failed");
  app.tasks.options.claudeBin = "/missing-claude";
  const missing = await app.tasks.start({ prompt: "hello" });
  const final = await completed(app, missing.id);
  assert.equal(final.status, "failed");
  assert.match(final.error, /找不到 Claude/);
});
test("workspace-root rejects symlink escapes", async (t) => {
  const app = await fixture(t);
  const workspace = path.join(app.root, "workspace");
  await mkdir(workspace);
  await symlink(os.tmpdir(), path.join(workspace, "escape"));
  app.tasks.options.workspaceRoot = workspace;
  await assert.rejects(
    app.tasks.validate({ prompt: "hi", cwd: path.join(workspace, "escape") }),
    (e) => e.status === 403,
  );
  assert.equal(
    (await app.tasks.validate({ prompt: "hi", cwd: workspace })).cwd,
    workspace,
  );
});
test("interrupted history is recovered after a server restart", async (t) => {
  const app = await fixture(t);
  const id = "22222222-2222-4222-8222-222222222222";
  await writeFile(
    path.join(app.opts.dataDir, `${id}.json`),
    JSON.stringify({
      id,
      status: "running",
      startedAt: new Date().toISOString(),
      events: [],
      raw: "partial",
      output: "",
    }),
  );
  const second = await createServer(app.opts);
  assert.equal(second.tasks.items.get(id).status, "interrupted");
  await second.close();
});
test("history reads original sessions, avoids duplicates, ignores partial lines and symlinks", async (t) => {
  const app = await fixture(t);
  const dir = path.join(app.home, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const id = "33333333-3333-4333-8333-333333333333";
  const rows = [
    {type:'custom-title',customTitle:'Friendly title'},
    {type:'user',cwd:app.root,message:{content:'<system-reminder>secret</system-reminder>hello'}},
    {type:'assistant',cwd:app.root,message:{model:'test-model',content:[{type:'text',text:'<script>alert(1)</script>'}]}}
  ];
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, rows.map(r=>JSON.stringify(r)).join('\n')+'\n{"incomplete"');
  await symlink(file,path.join(dir,'99999999-9999-4999-8999-999999999999.jsonl'));
  await mkdir(path.join(dir,id,'subagents'),{recursive:true});
  await writeFile(path.join(dir,id,'subagents','agent.jsonl'),JSON.stringify(rows[1]));
  const response = await app.request("/api/sessions");
  const data = await response.json();
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].title, "Friendly title");
  assert.ok(!("file" in data.sessions[0]));
  const detail = await (await app.request(`/api/sessions/${id}`)).json();
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].text, "hello");
  const exported = await app.request(`/api/sessions/${id}/export`);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  const resumed = await app.tasks.start({
    prompt: "continue",
    resumeId: id,
    cwd: app.root,
  });
  const final = await completed(app, resumed.id);
  const args = final.events.find((e) => e.data?.type === "test.args").data.args;
  assert.ok(args.includes("--resume"));
  assert.ok(args.includes(id));
  assert.ok(!args.includes("--color"));
});
test("Claude resumes/forks with native permission and budget flags", () => {
  const args = buildArgs({resumeId:'33333333-3333-4333-8333-333333333333',permissionMode:'plan',model:'sonnet',effort:'high',contextPaths:['/tmp/context'],maxBudgetUsd:1.5,forkSession:true});
  for (const flag of ['--print','--verbose','stream-json','--include-partial-messages','--resume','--fork-session','--permission-mode','plan','--max-budget-usd','1.5','--permission-prompts','none']) assert.ok(args.includes(flag),flag);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});
test("shutdown waits for pending validation and prevents orphan task startup", async (t) => {
  const app = await fixture(t);
  let release;
  app.tasks.validate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = app.tasks.start({ prompt: "slow" });
  const rejected = assert.rejects(pending, (e) => e.status === 503);
  const closing = app.tasks.close();
  release({
    prompt: "slow",
    cwd: app.root,
    permissionMode: "plan",
    model: "",
    effort: "",
    contextPaths: [],
    resumeId: "",
  });
  await rejected;
  await closing;
  assert.equal(app.tasks.active, null);
  assert.equal(app.tasks.items.size, 0);
});
test("a corrupt task record is set aside instead of blocking startup", async (t) => {
  const app = await fixture(t);
  const file = path.join(app.opts.dataDir, "44444444-4444-4444-8444-444444444444.json");
  await writeFile(file, "{broken");
  const second = await createServer(app.opts);
  t.after(() => second.close());
  assert.equal(second.tasks.items.size, 0);
  assert.match(await readFile(`${file}.corrupt`, "utf8"), /broken/);
});
test("finished tasks keep only summaries in memory and load details from disk", async (t) => {
  const app = await fixture(t);
  const item = await app.tasks.start({ prompt: "hello" });
  const final = await completed(app, item.id);
  assert.match(final.output, /const answer/);
  assert.ok(!("events" in app.tasks.items.get(item.id)));
  const detail = await (await app.request(`/api/tasks/${item.id}`)).json();
  assert.equal(detail.output, final.output);
  assert.equal(detail.threadId, "11111111-1111-4111-8111-111111111111");
});
test("session index reparses only changed transcripts", async (t) => {
  const app = await fixture(t);
  const dir = path.join(app.home, "projects", "demo");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "55555555-5555-4555-8555-555555555555.jsonl");
  const row = (text) => JSON.stringify({ type: "user", cwd: app.root, message: { content: text } }) + "\n";
  await writeFile(file, row("first"));
  assert.equal((await app.history.refresh())[0].title, "first");
  const cached = app.history.cache.get(file).item;
  await app.history.refresh();
  assert.equal(app.history.cache.get(file).item, cached);
  await writeFile(file, row("second") + row("more"));
  assert.equal((await app.history.refresh())[0].title, "second");
});
