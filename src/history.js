import { readdir, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class History {
  constructor(home) { this.home = home; this.index = new Map(); this.cache = new Map(); }
  async refresh() {
    // Reparse only transcripts whose size or mtime changed since the last scan.
    const index = new Map(), cache = new Map();
    const root = path.join(this.home, 'projects');
    try {
      if ((await lstat(root)).isSymbolicLink()) { this.index = index; return []; }
      for (const project of await readdir(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        for (const entry of await readdir(path.join(root, project.name), { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !UUID.test(entry.name.slice(0, -6))) continue;
          const file = path.join(root, project.name, entry.name);
          let info, item;
          try {
            info = await lstat(file);
            const key = `${info.mtimeMs}:${info.size}`;
            item = this.cache.get(file)?.key === key ? this.cache.get(file).item : await this.read(file, false);
            if (item) cache.set(file, { key, item });
          } catch (e) { if (e.code === 'ENOENT') continue; throw e; } // Deleted while scanning.
          if (item && (!index.has(item.id) || item.updated > index.get(item.id).updated)) index.set(item.id, { ...item, file });
        }
      }
    } catch (e) { if (!['ENOENT', 'EACCES'].includes(e.code)) throw e; }
    this.index = index;
    this.cache = cache;
    return this.list();
  }
  list() { return [...this.index.values()].sort((a,b) => b.updated.localeCompare(a.updated)).map(({file, ...item}) => item); }
  async get(id) {
    const entry = this.index.get(id);
    if (!entry) return null;
    // Recheck every ancestor, including after indexing, to reject swapped symlinks.
    for (const folder of [path.join(this.home, 'projects'), path.dirname(entry.file)])
      if ((await lstat(folder)).isSymbolicLink()) return null;
    return this.read(entry.file, true);
  }
  async read(file, detail) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const item = { id: path.basename(file, '.jsonl'), cwd: '', model: '', title: '', updated: stat.mtime.toISOString(), archived: false };
    const messages = []; let kept = 0, first = '', autoTitle = '', customTitle = '', error;
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    input.on('error', e => { error = e; lines.close(); });
    try {
      for await (const line of lines) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r !== 'object') continue;
        if (r.type === 'custom-title') customTitle = r.customTitle || customTitle;
        if (['ai-title', 'summary'].includes(r.type)) autoTitle = r.aiTitle || r.summary || autoTitle;
        if (!['user','assistant'].includes(r.type) || r.isSidechain || r.isMeta || !r.message) continue;
        item.cwd ||= typeof r.cwd === 'string' ? r.cwd : '';
        if (r.message.model && r.message.model !== '<synthetic>') item.model = r.message.model;
        const content = r.message.content;
        let text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n\n') : '';
        if (r.type === 'user') text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if (!text || /^<(local-command-|task-notification>|bash-std)/.test(text)) continue;
        if (r.type === 'user') first ||= text.split('\n')[0];
        if (detail && kept < 2_000_000) {
          const clipped = text.slice(0, 2_000_000 - kept); kept += clipped.length;
          messages.push({ role: r.type, text: clipped, time: r.timestamp || '' });
          if (clipped.length < text.length) item.truncated = true;
        } else if (detail) item.truncated = true;
      }
      if (error) throw error;
    } finally { lines.close(); input.destroy(); }
    item.title = String(customTitle || autoTitle || first || 'Untitled session').slice(0, 200);
    if (detail) item.messages = messages;
    return item;
  }
}
