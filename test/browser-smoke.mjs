import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createServer } from "../src/server.js";
const root = await mkdtemp(path.join(os.tmpdir(), "claude-web-browser-"));
const home = path.join(root, "claude");
await mkdir(path.join(home, "projects", "demo"), { recursive: true });
const id = "44444444-4444-4444-8444-444444444444";
await writeFile(
  path.join(home, "projects", "demo", `${id}.jsonl`),
  [
    {type:'user',cwd:root,message:{content:'Review the project'}},
    {type:'assistant',cwd:root,message:{content:[{type:'text',text:'<script>window.injected=true</script>\n\n## Previous result'}]}},
  ]
    .map((r) => JSON.stringify(r))
    .join("\n"),
);
// The fake CLI reports this session id; real Claude would write its transcript.
const threadFile = path.join(home, "projects", "demo", "11111111-1111-4111-8111-111111111111.jsonl");
await writeFile(threadFile, JSON.stringify({ type: "user", cwd: root, message: { content: "fixture thread" } }));
await utimes(threadFile, new Date("2020-01-01"), new Date("2020-01-01"));
const token = "browser-test-token-123456789";
const app = await createServer({
  cwd: root,
  claudeHome: home,
  dataDir: path.join(root, "data"),
  claudeBin: fileURLToPath(new URL("./fake-claude.js", import.meta.url)),
  token,
  pluginsDir: fileURLToPath(new URL("../examples/plugins", import.meta.url)),
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1040 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector("#workspace:not([hidden])");
  assert.equal(new URL(page.url()).search, "");
  await page.click('[data-preset="review"]');
  await page.click("#run");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("已完成"),
  );
  // Status and answer rendering are scheduled separately; wait for visible output.
  await page.waitForFunction(() =>
    document.querySelector("#structured").textContent.includes("const answer = 42"),
  );
  assert.match(
    await page.locator("#structured").innerText(),
    /const answer = 42/,
  );
  await page.click("#raw-tab");
  await page.waitForSelector(".xterm-screen");
  await page.click("#structured-tab");
  await page.screenshot({
    path: process.env.SCREENSHOT_PATH || path.join(root, "desktop.png"),
    fullPage: true,
  });
  assert.match(await page.locator('#metrics').innerText(), /0.0123/);
  // A finished task continues its conversation by default; users can opt out and back in.
  await page.waitForSelector("#resume-banner:not([hidden])");
  assert.match(await page.locator("#resume-label").innerText(), /继续会话/);
  assert.equal(await page.inputValue("#prompt"), "");
  await page.click("#cancel-resume");
  await page.click("#follow-up");
  assert.match(await page.locator("#resume-label").innerText(), /继续会话/);
  await page.fill("#prompt", "follow-up question");
  await page.click("#run");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("已完成") &&
    document.querySelectorAll("#thread .turn-block").length === 1,
  );
  assert.match(await page.locator("#history-list").innerText(), /2 轮/);
  assert.match(await page.locator("#thread").innerText(), /const answer = 42/);
  await page.click("#cancel-resume");
  await page.setInputFiles('#attachments',{name:'design.png',mimeType:'image/png',buffer:Buffer.from('test-image')});
  await page.waitForFunction(()=>document.querySelector('#upload-status').textContent.includes('已上传'));
  assert.match(await page.inputValue('#prompt'),/webdesk-uploads/);
  await page.click('#files-toggle');
  await page.getByRole('button',{name:'▱ webdesk-uploads',exact:true}).click();
  const fileDownload = page.waitForEvent('download');
  await page.locator('#files-list a').first().click();
  assert.match((await fileDownload).suggestedFilename(),/design.png/);
  await page.click('[data-plugin="server-info"]');
  const info = page.frameLocator("#plugin-frame");
  await info.locator("#info strong").first().waitFor();
  assert.ok((await info.locator("#info").innerText()).includes("主机"));
  await page.click('[data-plugin="claude-history"]');
  const historyFrame = page.frameLocator("#plugin-frame");
  await historyFrame.locator(".session").first().waitFor();
  await historyFrame.locator("#search").fill("Previous result");
  assert.equal(await historyFrame.locator(".session").count(), 1);
  await historyFrame.locator(".session").click();
  assert.equal(await historyFrame.locator("#detail script").count(), 0);
  if (process.env.HISTORY_SCREENSHOT_PATH)
    await page.screenshot({
      path: process.env.HISTORY_SCREENSHOT_PATH,
      fullPage: true,
    });
  const downloaded = page.waitForEvent("download");
  await historyFrame.locator("#export").click();
  assert.match((await downloaded).suggestedFilename(), /claude-history.*html/);
  await historyFrame
    .getByRole("button", { name: "在工作台继续", exact: true })
    .click();
  await page.waitForSelector("#workbench-view:not([hidden])");
  await page.waitForSelector("#resume-banner:not([hidden])");
  assert.match(
    await page.locator("#resume-label").innerText(),
    /Review the project/,
  );
  await page.click("#cli-history");
  await page.waitForSelector(".history-item");
  await page.click(".history-item");
  await page.waitForSelector("#resume-banner:not([hidden])");
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator("#structured script").count(), 0);
  await page.fill("#prompt", "continue");
  await page.click("#run");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("已完成"),
  );
  assert.ok(app.tasks.list().some((task) => task.resumeId === id));
  await page.click("#new-task");
  await page.fill("#prompt", "slow");
  await page.locator("#prompt").press("Control+Enter");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("运行中"),
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("运行中"),
  );
  await page.click("#stop");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("已中断"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.click("#workbench-view .menu-toggle");
  await page.waitForTimeout(300);
  await page.click("#logout");
  await page.waitForSelector("#login:not([hidden])");
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: auto-continue, threaded follow-up, files drawer, plugin navigation, custom plugin API, full-text history search, HTML export, direct resume, login, presets, streaming, terminal, history, XSS sanitization, resume, keyboard submit, reload, stop, mobile, logout.",
  );
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
