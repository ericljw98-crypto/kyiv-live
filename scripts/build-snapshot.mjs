#!/usr/bin/env node
'use strict';

// 生成一份可由 GitHub 静态托管的聚合快照。
//
// 本机 Node 数据服务提供实时接口；GitHub 侧由 Actions 的常驻循环
// （scripts/cloud-snapshot-loop.mjs）反复调用同一套聚合逻辑，把结果写成静态
// JSON 推到 snapshot 分支。客户端从 raw.githubusercontent.com 直接读取，
// 不依赖任何一台电脑在线。
//
// 用法： node scripts/build-snapshot.mjs [输出路径]
// 输出默认写到 data/status.json，同时始终写入 process.cwd()/snapshot-out/status.json
// 供 workflow 单独推送到 snapshot 分支。

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => {
  const full = path.join(ROOT, p);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, s, 'utf8');
};

const { getStatus, getPower, getWater } = require(path.join(ROOT, 'server', 'sources.js'));
const meta = JSON.parse(read('version.json'));
const repo = String(meta.repo || 'ericljw98-crypto/kyiv-live');
const asset = String(meta.apkAsset || 'kyiv-live-debug.apk');

const DEFAULT_GROUP = '19.1';

async function settled(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[warn] ${label} 失败：${err?.message || err}`);
    return null;
  }
}

function unavailable(errText) {
  return {
    status: 'unavailable',
    error: errText,
    checkedAt: new Date().toISOString(),
  };
}

async function latestRelease() {
  // 版本真源是仓库里的 version.json；GitHub Release 只用于校正资产大小与直链。
  // 无外网时静默降级，不影响快照生成。
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'kyiv-live-snapshot', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 袭击后果索引是人工校订过的公开报道清单，随快照一起分发。
// 缺少或格式不对时只让这一模块显示「暂无索引」，不影响警报、电力与供水。
function readAftermath() {
  try {
    const j = JSON.parse(read('data/aftermath.json'));
    if (!j || j.schema !== 1 || !Array.isArray(j.items)) return null;
    return { updatedAt: j.updatedAt || '', policy: String(j.policy || ''), items: j.items };
  } catch (err) {
    console.warn(`[warn] 袭击后果索引读取失败：${err?.message || err}`);
    return null;
  }
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

async function main() {
  const started = Date.now();
  // getStatus 内部对三个源做 Promise.allSettled，任一失败都会返回 unavailable，
  // 不会让整份快照生成失败，也不会用推测值冒充实时状态。
  const base = await getStatus(DEFAULT_GROUP, 'local');
  const groups = Array.isArray(base.power?.groups) && base.power.groups.length
    ? base.power.groups : [DEFAULT_GROUP];

  // 同进程内上游响应走 5 分钟缓存，这里只是按分组重新做本地计算，不再打上游。
  const powerByGroup = {};
  for (const g of groups) {
    const p = await settled(`分组 ${g}`, () => getPower(g));
    if (p) powerByGroup[g] = p;
  }
  if (!powerByGroup[DEFAULT_GROUP] && base.power) powerByGroup[DEFAULT_GROUP] = base.power;

  const waterByScope = {};
  if (base.water) waterByScope.local = base.water;
  const waterAll = await settled('全市供水范围', () => getWater('all'));
  if (waterAll) waterByScope.all = waterAll;

  let apk = { size: null, sha256: null };
  try {
    const p = path.join(ROOT, 'dist', asset);
    const { createHash } = require('node:crypto');
    const buf = readFileSync(p);
    apk.size = statSync(p).size;
    apk.sha256 = createHash('sha256').update(buf).digest('hex');
  } catch { /* Release 资产信息是可选增强 */ }

  const release = await latestRelease();
  const releaseTag = String(release?.tag_name || '');
  // 取两者中较高的版本：version.json 是下一次待发布版本的真源，
  // latest Release 是已经可下载的版本，正常情况下两者一致。
  const version = cmp(releaseTag, meta.version) > 0 ? releaseTag.replace(/^v/i, '') : meta.version;
  const releaseAsset = (release?.assets || []).find((a) => a.name === asset);
  const apkUrl = `https://github.com/${repo}/releases/download/v${version}/${asset}`;

  const degraded = base.alert?.status !== 'ok'
    && base.power?.status !== 'ok'
    && base.water?.status !== 'ok';

  const snapshot = {
    schema: 1,
    mode: 'snapshot',
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - started,
    degraded,
    kyiv: base.kyiv,
    hasOfficialToken: Boolean(base.hasOfficialToken),
    alert: base.alert || unavailable('警报源不可用'),
    powerByGroup,
    waterByScope,
    aftermath: readAftermath(),
    app: {
      version,
      versionCode: Number(meta.versionCode) || 0,
      releasedAt: meta.releasedAt || '',
      notes: String(meta.notes || '新版本已发布，建议更新。'),
      apkAsset: asset,
      apkUrl,
      size: releaseAsset?.size ?? apk.size,
      sha256: String(releaseAsset?.digest || '').replace(/^sha256:/, '') || apk.sha256,
      source: 'github-actions',
    },
  };

  const json = `${JSON.stringify(snapshot)}\n`;
  const outArg = process.argv[2];
  if (outArg) write(outArg, json);
  write('data/status.json', json);
  write('snapshot-out/status.json', json);

  console.log(`快照已生成：${Object.keys(powerByGroup).length} 个停电分组，`
    + `${Object.keys(waterByScope).length} 种供水范围，版本 ${version}，`
    + `耗时 ${snapshot.buildMs} ms${degraded ? '（上游全部不可用，已标记 degraded）' : ''}`);
}

main().catch((err) => {
  console.error(`快照生成失败：${err?.stack || err}`);
  process.exit(1);
});
