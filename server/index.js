'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { getStatus, getAlert, getPower, getWater, resolveAddress } = require('./sources');
const { cacheStats } = require('./cache');

// ------------------------------------------------------------------ env
function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '').trim();
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  } catch { /* .env 是可选的 */ }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const WWW = path.join(__dirname, '..', 'www');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function sendStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(WWW, '.' + rel);
  if (!target.startsWith(path.resolve(WWW) + path.sep) && target !== path.resolve(WWW, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(target, (err, stat) => {
    let file = target;
    if (err || !stat.isFile()) {
      // SPA 回退只针对无扩展名路径，避免把缺失的 js/css 当成 HTML 返回
      if (path.extname(rel)) { res.writeHead(404); res.end('Not found'); return; }
      file = path.join(WWW, 'index.html');
    }
    fs.readFile(file, (readErr, buf) => {
      if (readErr) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      const isApiLike = ext === '.html' || ext === '.webmanifest' || ext === '.js';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': isApiLike ? 'no-cache' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
}

async function handleApi(req, res, u) {
  const q = u.searchParams;
  const group = q.get('group') || '19.1';
  const scope = q.get('water') || q.get('scope') || 'local';
  switch (u.pathname) {
    case '/api/status': return sendJson(res, 200, await getStatus(group, scope));
    case '/api/alerts': return sendJson(res, 200, await getAlert());
    case '/api/power': return sendJson(res, 200, await getPower(group));
    case '/api/water': return sendJson(res, 200, await getWater(scope));
    case '/api/resolve-address': {
      const street = q.get('street') || '';
      const house = q.get('house') || '';
      if (!street.trim()) return sendJson(res, 400, { error: '缺少 street 参数' });
      return sendJson(res, 200, await resolveAddress(street, house));
    }
    case '/api/config': return sendJson(res, 200, {
      hasOfficialToken: Boolean((process.env.ALERTS_UA_TOKEN || '').trim()),
      officialSource: 'alerts.in.ua',
      fallbackSource: 'tryvoha.online',
      serverTime: new Date().toISOString(),
    });
    case '/api/health': return sendJson(res, 200, {
      ok: true, uptimeSeconds: Math.round(process.uptime()), cache: cacheStats(),
    });
    default: return sendJson(res, 404, { error: 'unknown endpoint' });
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (u.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, u);
    } catch (err) {
      sendJson(res, 502, { error: err.message, at: new Date().toISOString() });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method not allowed'); return;
  }
  sendStatic(req, res, u.pathname);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`基辅民生信息 · 服务已启动`);
  console.log(`  本机:   http://${shown}:${PORT}`);
  console.log(`  局域网: http://<本机局域网IP>:${PORT}  （手机与电脑需在同一网络）`);
  console.log(`  官方警报 API token: ${process.env.ALERTS_UA_TOKEN ? '已配置' : '未配置（使用免密钥公开源）'}`);
});
