#!/usr/bin/env node
'use strict';

// 由能访问乌克兰上游的机器生成一份「完整」快照并推送到 GitHub 的 snapshot 分支。
// 手机始终只读 GitHub，不需要与这台机器同网，也不要求它实时在线；
// 它停止运行后，手机仍能读取最后一次成功快照，页面会显示生成时间与过期提示。
//
//   GITHUB_TOKEN=<classic PAT> npm run snapshot:push        # 推送一次
//   GITHUB_TOKEN=<classic PAT> npm run snapshot:loop        # 每 5 分钟推送一次
//
// GitHub Actions 的出口 IP 实测会被部分上游以 403 拒绝，因此工作流在快照不完整时
// 会跳过发布，避免覆盖这里推送的完整数据。令牌只经环境变量传入，不写入任何文件。

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'ericljw98-crypto/kyiv-live';
const INTERVAL_MS = 5 * 60 * 1000;
const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();

if (!token) {
  console.error('缺少 GITHUB_TOKEN。请在当前终端设置具备 repo 权限的 classic PAT 后重跑。');
  process.exit(1);
}

function isOk(x) { return Boolean(x && x.status === 'ok'); }

function pushOnce() {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-snapshot.mjs')], {
    cwd: ROOT, stdio: 'inherit',
  });
  const src = path.join(ROOT, 'snapshot-out', 'status.json');
  const j = JSON.parse(readFileSync(src, 'utf8'));
  const power = Object.values(j.powerByGroup || {})[0];
  const complete = isOk(j.alert) && isOk(power) && isOk(j.waterByScope?.local);
  if (!complete) {
    console.warn('本次上游数据不完整，拒绝推送，以免用残缺快照覆盖线上已有数据。');
    return false;
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kyiv-snapshot-'));
  try {
    copyFileSync(src, path.join(tmp, 'status.json'));
    const git = (args) => execFileSync('git', args, {
      cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    git(['init', '-q']);
    git(['checkout', '-q', '-b', 'snapshot']);
    git(['config', 'user.name', 'github-actions[bot]']);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    git(['add', 'status.json']);
    git(['commit', '-q', '-m', `数据快照 ${new Date().toISOString()}`]);
    git(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    git(['-c', 'credential.helper=',
      '-c', `http.extraheader=AUTHORIZATION: basic ${basic}`,
      'push', '-q', '--force', 'origin', 'snapshot']);
    console.log(`已推送完整快照：${j.generatedAt} · ${Object.keys(j.powerByGroup).length} 个分组 · 版本 ${j.app.version}`);
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  pushOnce();
} catch (err) {
  console.error(`推送失败：${err?.message || err}`);
  if (!process.argv.includes('--loop')) process.exit(1);
}

if (process.argv.includes('--loop')) {
  console.log(`常驻模式已启动，每 ${INTERVAL_MS / 60000} 分钟推送一次；按 Ctrl+C 停止。`);
  setInterval(() => {
    try { pushOnce(); } catch (err) { console.error(`本轮推送失败：${err?.message || err}`); }
  }, INTERVAL_MS);
}
