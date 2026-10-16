/**
 * Web console server: serves the single-page UI and proxies /api/* to the core service.
 * Proxying keeps the browser on one origin (no CORS) and lets the operator's ADMIN_TOKEN stay server-side.
 *
 *   API_URL      core service base URL            (default http://localhost:3000)
 *   ADMIN_TOKEN  optional; used for account creation when the browser does not send its own
 *   PORT         listen port                       (default 8080)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface WebConfig { apiUrl: string; adminToken?: string; publicDir: string }

const FORWARD_HEADERS = ['content-type', 'x-api-key', 'x-admin-token'];

export function createWebServer(cfg: WebConfig): http.Server {
  const indexHtml = () => fs.readFileSync(path.join(cfg.publicDir, 'index.html'));

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');

      if (url.pathname === '/_config') {
        return json(res, 200, { adminTokenConfigured: Boolean(cfg.adminToken) });
      }

      if (url.pathname.startsWith('/api/')) {
        const target = cfg.apiUrl.replace(/\/$/, '') + url.pathname.slice('/api'.length) + url.search;
        const headers: Record<string, string> = {};
        for (const h of FORWARD_HEADERS) {
          const v = req.headers[h];
          if (typeof v === 'string' && v) headers[h] = v;
        }
        if (url.pathname === '/api/admin/accounts' && !headers['x-admin-token'] && cfg.adminToken) {
          headers['x-admin-token'] = cfg.adminToken;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        let upstream: Response;
        try {
          upstream = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
        } catch {
          return json(res, 502, { error: { code: 'SERVICE_UNREACHABLE', message: `Cannot reach the quota service at ${cfg.apiUrl}` } });
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
        return res.end(buf);
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(indexHtml());
      }
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

if (require.main === module) {
  const cfg: WebConfig = {
    apiUrl: process.env.API_URL ?? 'http://localhost:3000',
    adminToken: process.env.ADMIN_TOKEN || undefined,
    publicDir: process.env.WEB_PUBLIC_DIR ?? path.resolve(process.cwd(), 'web/public'),
  };
  const port = Number(process.env.PORT ?? 8080);
  createWebServer(cfg).listen(port, '0.0.0.0', () => console.log(`Quota console on http://localhost:${port} -> ${cfg.apiUrl}`));
}
