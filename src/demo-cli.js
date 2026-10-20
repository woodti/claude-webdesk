#!/usr/bin/env node
// Public demo fixture. Never launches Claude, executes a prompt or contacts a model.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const argv = process.argv.slice(2);
const resumed = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : '';
const session_id = resumed && !argv.includes('--fork-session') ? resumed : randomUUID();
const send = data => console.log(JSON.stringify({ ...data, session_id }));
send({type:'system', subtype:'init', model:'demo · simulated', tools:['Read','Grep']});
send({type:'assistant', message:{content:[{type:'tool_use',name:'Read',input:{file_path:'README.md'}}]}});
send({type:'stream_event',event:{type:'message_start'}});
const text = `## Workspace review\n\nThis is a **simulated Claude response**. No model was called and no project files were changed.\n\n### A small, testable next step\n\n1. Read the project conventions and identify the affected behavior.\n2. Reproduce the issue with a focused test.\n3. Apply the smallest fix and rerun the checks.\n\n\`\`\`js\n// Prevent repeated submissions while a request is active.\nif (pending) return;\npending = true;\ntry { await submit(); } finally { pending = false; }\n\`\`\`\n\nTry uploading a screenshot, browsing project files, or opening **CLI sessions** to continue the sample conversation.\n\n> Demo metrics below are synthetic, not a bill.\n`;
for (const chunk of text.match(/.{1,28}(?:\n|$)?|\n/g) || []) {
  send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:chunk}}});
  await new Promise(resolve => setTimeout(resolve, 110));
}
send({type:'assistant',message:{content:[{type:'text',text}]}});
send({type:'result',subtype:'success',is_error:false,result:text,total_cost_usd:0.0184,num_turns:2,duration_ms:4200,usage:{input_tokens:1248,output_tokens:286,cache_read_input_tokens:4096}});
// Record a transcript in the demo's Claude home so follow-up questions can resume this session.
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'demo');
const now = new Date().toISOString();
await mkdir(folder, { recursive: true });
await appendFile(path.join(folder, `${session_id}.jsonl`), [
  { type: 'user', cwd: process.cwd(), timestamp: now, message: { content: prompt } },
  { type: 'assistant', cwd: process.cwd(), timestamp: now, message: { model: 'demo', content: [{ type: 'text', text }] } },
].map(r => JSON.stringify(r) + '\n').join(''));
