let api, current = '', bound = false;
const $ = id => document.getElementById(id);
// Keep the auto-growing prompt in sync when paths are inserted programmatically.
function append(line) {
  const prompt = $('prompt');
  prompt.value += (prompt.value && !prompt.value.endsWith('\n') ? '\n' : '') + line;
  prompt.dispatchEvent(new Event('input'));
}
function report(e) { $('upload-status').textContent = e.message || String(e); }
async function browse(folder = current) {
  const data = await api('/api/files?path=' + encodeURIComponent(folder));
  current = folder;
  $('files-path').textContent = data.root + (folder ? '/' + folder : '') + ' · 隐藏文件与符号链接不共享';
  const list = $('files-list'); list.replaceChildren();
  if (folder) {
    const up = document.createElement('button'); up.textContent = '↰ 上一级';
    up.onclick = () => browse(folder.split('/').slice(0,-1).join('/')).catch(report); list.append(up);
  }
  for (const entry of data.entries) {
    const row = document.createElement('div'); row.className = 'file-row';
    const name = document.createElement(entry.directory ? 'button' : 'span');
    name.textContent = (entry.directory ? '▱ ' : '▤ ') + entry.name;
    if (entry.directory) name.onclick = () => browse(entry.path).catch(report);
    const actions = document.createElement('div');
    const attach = document.createElement('button'); attach.textContent = '引用路径';
    attach.onclick = () => { append(JSON.stringify(data.root + '/' + entry.path)); $('prompt').focus(); };
    actions.append(attach);
    if (!entry.directory) {
      const size = document.createElement('small'); size.textContent = (entry.size / 1024).toFixed(1) + ' KB';
      const download = document.createElement('a'); download.textContent = '下载 ↓'; download.href = '/api/files/download?path=' + encodeURIComponent(entry.path);
      actions.prepend(size); actions.append(download);
    }
    row.append(name, actions); list.append(row);
  }
  if (!data.entries.length) { const empty = document.createElement('p'); empty.textContent = '此目录没有可共享文件。'; list.append(empty); }
}
async function upload(files) {
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) throw new Error('单文件不能超过 25 MiB');
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload?name=' + encodeURIComponent(file.name || 'screenshot.png'));
      xhr.upload.onprogress = e => { $('upload-status').textContent = `${file.name} · ${e.lengthComputable ? Math.round(e.loaded/e.total*100) + '%' : '上传中'}`; };
      xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { reject(new Error('上传响应无效')); return; } xhr.status === 201 ? resolve(data) : reject(new Error(data.error || '上传失败')); };
      xhr.onerror = () => reject(new Error('上传连接中断')); xhr.send(file);
    });
    append(`请读取上传文件：${JSON.stringify(result.absolutePath)}`);
    $('upload-status').textContent = '✓ 已上传并附加路径 · ' + result.name;
  }
  if (!$('file-browser').hidden) await browse();
}
export const browseFiles = () => browse();
let uploading = false;
async function enqueue(files) {
  if (uploading) { report(new Error('请等待当前上传完成')); return; }
  uploading = true;
  try { await upload(files); } catch (e) { report(e); } finally { uploading = false; $('attachments').value = ''; }
}
export async function initializeFiles(client) {
  api = client;
  if (!bound) {
    bound = true;
    $('files-refresh').onclick = () => browse().catch(report);
    $('attachments').onchange = e => enqueue([...e.target.files]);
    const drop = $('drop-zone');
    for (const name of ['dragenter','dragover']) drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragging'); enqueue([...e.dataTransfer.files]); });
    $('prompt').addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); enqueue(files); } });
  }
}
