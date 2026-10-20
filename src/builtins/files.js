import { realpath, readdir, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../tasks.js';
const LIMIT = 25 * 1024 * 1024;
// Hide private configuration and dependency/build trees in the browser.
const hidden = name => name.startsWith('.') || ['node_modules', '__pycache__'].includes(name) || /\.(pem|key|p12|pfx)$/i.test(name);
export function filesPlugin({ options }) {
  const rootPath = options.cwd;
  async function locate(value = '') {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) throw new HttpError(400, '请使用相对文件路径');
    const parts = value.split('/').filter(Boolean);
    if (parts.some(p => p === '..' || hidden(p))) throw new HttpError(403, '隐藏或私密路径不共享');
    const root = await realpath(rootPath);
    let target = root;
    for (const part of parts) {
      target = path.join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new HttpError(403, '符号链接不共享');
    }
    const resolved = await realpath(target);
    const rel = path.relative(root, resolved);
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw new HttpError(403, '路径超出项目目录');
    return resolved;
  }
  return {
    id: 'files', name: '项目文件', description: 'Upload screenshots and download artifacts', icon: '↥', order: 30,
    type: 'native', aliases: ['/api/files'],
    async handle({ req, res, url, route: local, legacy, json }) {
      const route = legacy ? local : '/api' + local;
      try {
        if (route === '/api/files' && req.method === 'GET') {
          const relative = url.searchParams.get('path') || '';
          const folder = await locate(relative);
          if (!(await lstat(folder)).isDirectory()) throw new HttpError(400, '不是目录');
          const entries = [];
          for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
            if (hidden(entry.name) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
            const info = await lstat(path.join(folder, entry.name));
            entries.push({ name: entry.name, directory: entry.isDirectory(), size: info.size, path: path.posix.join(relative, entry.name) });
            if (entries.length >= 1000) break;
          }
          json(res, 200, { root: await realpath(rootPath), path: relative, entries, limit: 1000 }); return true;
        }
        if (route === '/api/files/download' && req.method === 'GET') {
          const file = await locate(url.searchParams.get('path'));
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new HttpError(400, '不是普通文件');
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
              'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(path.basename(file)).replace(/'/g, '%27')}`,
              'Content-Security-Policy': "default-src 'none'; sandbox" });
            const stream = handle.createReadStream();
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            stream.pipe(res);
          } catch (e) { await handle.close(); throw e; }
          return true;
        }
        if (route === '/api/files/upload' && req.method === 'POST') {
          if (Number(req.headers['content-length']) > LIMIT) throw new HttpError(413, '单文件不能超过 25 MiB');
          const name = url.searchParams.get('name') || 'upload';
          if (name.length > 180 || /[/\\\x00-\x1f]/.test(name) || hidden(name)) throw new HttpError(400, '文件名无效或为私密文件');
          const base = await realpath(rootPath);
          await mkdir(path.join(base, 'webdesk-uploads'), { recursive: true, mode: 0o700 });
          const folder = await locate('webdesk-uploads');
          const file = path.join(folder, `${randomUUID()}-${name}`);
          const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          let size = 0;
          try {
            for await (const chunk of req) {
              size += chunk.length;
              if (size > LIMIT) throw new HttpError(413, '单文件不能超过 25 MiB');
              let offset = 0;
              while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
            }
          } catch (e) { await handle.close(); await unlink(file).catch(() => {}); throw e; }
          await handle.close();
          json(res, 201, { name, size, path: path.relative(base, file), absolutePath: file }); return true;
        }
      } catch (e) {
        if (e.code === 'ENOENT') throw new HttpError(404, '文件不存在');
        if (['EACCES','ELOOP'].includes(e.code)) throw new HttpError(403, '无权访问该文件');
        throw e;
      }
      return false;
    },
  };
}
