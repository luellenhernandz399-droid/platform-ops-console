// node:http 适配层。Router 本身与传输无关，便于直接单测。
// 同时托管 web/ 下的控制台静态资源，API 与前端同源，避免跨域配置。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlatformConsole } from '../app.ts';
import { Router } from './router.ts';

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../web',
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function createServer(app: PlatformConsole): http.Server {
  const router = new Router(app);

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // 非 API 路径一律交给控制台前端
    if (!url.pathname.startsWith('/platform/v1')) {
      void serveStatic(url.pathname, res);
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 'VALIDATION_ERROR', message: '请求体不是合法 JSON' }));
          return;
        }
      }

      const query: Record<string, string | string[]> = {};
      for (const key of url.searchParams.keys()) {
        const values = url.searchParams.getAll(key);
        query[key] = values.length > 1 ? values : values[0];
      }

      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }

      const result = router.handle({
        method: req.method ?? 'GET',
        path: url.pathname,
        query,
        body,
        headers,
      });

      res.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(result.body === null ? '' : JSON.stringify(result.body));
    });
  });
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_ROOT, rel);

  // 目录穿越防护
  if (!target.startsWith(WEB_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    // 单页应用：未命中的路径回落到 index.html，由前端路由接管
    try {
      const fallback = await readFile(path.join(WEB_ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(fallback);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}
