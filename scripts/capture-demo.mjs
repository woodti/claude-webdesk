import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from '../src/server.js';
import {seedDemo} from '../src/demo.js';
const root = await mkdtemp(path.join(os.tmpdir(),'claude-webdesk-showcase-'));
await seedDemo(root);
const token='showcase-temporary-token';
const app=await createServer({cwd:path.join(root,'project'),claudeHome:path.join(root,'claude'),dataDir:path.join(root,'data'),claudeBin:process.execPath,token,demo:true});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});
try {
  await mkdir('docs',{recursive:true});
  const page=await browser.newPage({viewport:{width:1480,height:1180},deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${app.server.address().port}/#token=${token}`);
  await page.waitForSelector('#workspace:not([hidden])');
  await page.fill('#prompt','Review the checkout flow. Find a focused fix for duplicate submissions and suggest tests.');
  await page.click('#settings-toggle');
  await page.fill('#model','sonnet');
  await page.fill('#budget','1.00');
  await page.click('#run');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已完成'));
  await page.waitForSelector('#metrics:not([hidden])');
  await page.screenshot({path:'docs/screenshot.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'docs/mobile.png',fullPage:true});
  console.log('Saved desktop/mobile screenshots from the isolated, simulated demo.');
} finally {await browser.close();await app.close();await rm(root,{recursive:true,force:true});}
