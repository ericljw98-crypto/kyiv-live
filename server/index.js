'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
// 只监听本机回环：手机端不连接这台服务，数据一律经 GitHub 静态快照分发。
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const APK_NAME = 'kyiv-live-debug.apk';
const APK_FILE = path.join(ROOT, APK_NAME);

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

// ------------------------------------------------------------------ APK 分发
// 只按精确路径提供根目录中的这一个安装包，不暴露项目目录，也不接受用户传入的路径。
let apkCache = { mtimeMs: -1 };
function getApk() {
  try {
    const st = fs.statSync(APK_FILE);
    if (apkCache.mtimeMs !== st.mtimeMs) {
      const buf = fs.readFileSync(APK_FILE);
      apkCache = {
        mtimeMs: st.mtimeMs, buf, size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      };
    }
    return apkCache;
  } catch { return null; }
}

// 版本真源：根目录 version.json（由 scripts/write-version.mjs 同步到各处）。
function getVersionMeta() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  } catch {
    return { version: '0.0.0', versionCode: 0, notes: '', releasedAt: '' };
  }
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
      // 不做 SPA 回退：错误地址必须明确返回 404，避免前端把网页当 JSON 解析
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    fs.readFile(file, (readErr, buf) => {
      if (readErr) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      // JSON 里包含版本与默认地址，不能被浏览器长期缓存，否则会读到过期的版本信息
      const isApiLike = ['.html', '.webmanifest', '.js', '.json'].includes(ext);
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
    case '/api/apk-info': {
      const a = getApk();
      return sendJson(res, a ? 200 : 404, a
        ? { exists: true, filename: APK_NAME, size: a.size, sha256: a.sha256 }
        : { exists: false, error: 'APK 尚未生成' });
    }
    // 本机调试用的版本信息。手机端不访问此接口，更新检查只读 GitHub 快照与 Release。
    case '/api/update': {
      const meta = getVersionMeta();
      return sendJson(res, 200, {
        version: meta.version,
        versionCode: meta.versionCode,
        releasedAt: meta.releasedAt,
        notes: meta.notes,
        source: 'local-debug',
        serverTime: new Date().toISOString(),
      });
    }
    case '/api/health': return sendJson(res, 200, {
      ok: true, uptimeSeconds: Math.round(process.uptime()), cache: cacheStats(),
    });
    default: return sendJson(res, 404, { error: 'unknown endpoint' });
  }
}

const server = http.createServer(async (req, res) => {
  // URL 会把 //api/... 解析成另一个主机名，需在解析前按原始路径拦截。
  const rawPath = String(req.url || '').split('?')[0];
  if (/^\/{2,}api\//i.test(rawPath)) {
    return sendJson(res, 404, { error: '地址路径含重复斜杠，请检查数据服务地址末尾是否多写了 /' });
  }
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

  // 含重复斜杠的 /api 路径也必须落到 JSON 响应，不能被静态回退伪装成网页。
  if (/^\/+api\//i.test(u.pathname)) {
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
  console.log(`基辅安全信息汇总 · 本机快照生成与预览服务已启动`);
  console.log(`  地址: http://${HOST}:${PORT}（仅本机，手机不连接此服务）`);
  console.log(`  数据分发: npm run snapshot:push 推送到 GitHub 快照分支`);
  console.log(`  官方警报 API token: ${process.env.ALERTS_UA_TOKEN ? '已配置' : '未配置（使用免密钥公开源）'}`);
});
