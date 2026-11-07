'use strict';

// 校验 .env 里的 ALERTS_UA_TOKEN 是否可用：npm run check:token
// 只读取 token，不打印出来，也不会写回任何文件。
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
let token = process.env.ALERTS_UA_TOKEN || '';
if (!token && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*ALERTS_UA_TOKEN\s*=\s*(.*?)\s*$/);
    if (m) token = m[1].replace(/^["']|["']$/g, '').trim();
  }
}
if (!token) {
  console.log('未配置 ALERTS_UA_TOKEN。把 .env.example 复制为 .env 并填入申请到的 token。');
  process.exit(1);
}

(async () => {
  const res = await fetch('https://api.alerts.in.ua/v1/alerts/active.json', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  console.log('HTTP', res.status);
  const body = await res.text();

  if (res.status === 200) {
    const data = JSON.parse(body);
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    const kyiv = alerts.find((a) => String(a.location_uid) === '31');
    console.log('token 有效。当前生效警报条数:', alerts.length);
    console.log('基辅市（UID 31）:', kyiv ? '警报生效' : '无生效警报');
    if (kyiv) {
      console.log(JSON.stringify({
        alert_level: kyiv.alert_level,
        alert_type: kyiv.alert_type,
        started_at: kyiv.started_at,
        threats: kyiv.threats,
        notes: kyiv.notes,
      }, null, 2));
    }
    return;
  }
  if (res.status === 401) console.log('token 无效、已撤销或已过期。');
  else if (res.status === 403) console.log('IP 被封，或 API 在当前所在国家/地区不可用。');
  else if (res.status === 429) console.log('超过限流（软限 8–10 次/分，硬限 12 次/分）。');
  else console.log(body.slice(0, 300));
  process.exitCode = 1;
})().catch((err) => {
  console.log('请求失败:', err.message);
  process.exitCode = 1;
});
