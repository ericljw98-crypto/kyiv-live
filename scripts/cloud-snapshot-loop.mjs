#!/usr/bin/env node
'use strict';

// 云端常驻快照循环：在 GitHub Actions 的一个 job 内按 5 分钟刻度持续生成并发布快照。
//
// 背景：GitHub 只保证 scheduled 事件「一小时内触发」，高频 cron 实测会被大量丢弃
// （本仓库曾出现 12 小时仅 1 次定时运行）。因此把 5 分钟节奏放进 job 内部由本脚本
// 自己对齐 UTC 刻度，平台定时只负责「接力 / 续命」：新运行接管后重新开始循环，
// 即使连续多次定时被丢弃，当前运行仍会持续发布到最长运行时长。
//
// 用法（由 .github/workflows/snapshot.yml 调用）：
//   GH_TOKEN=<GITHUB_TOKEN> GH_REPO=owner/repo node scripts/cloud-snapshot-loop.mjs
// 调试：
//   LOOP_ROUNDS=2 DRY_RUN=1 node scripts/cloud-snapshot-loop.mjs
//
// 发布策略与工作流原有逻辑一致：本轮数据完整则直接发布；不完整时只有线上快照
// 已经陈旧（>= 10 分钟）才发布降级快照，避免覆盖本机刚推送的完整数据。不可用字段
// 由客户端显示「暂不可用」，不拿旧值冒充实时状态。

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERIOD_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
const MAX_MS = Number(process.env.LOOP_MAX_MINUTES || 350) * 60 * 1000;
const ROUNDS = Number(process.env.LOOP_ROUNDS || 0);
const DRY_RUN = process.env.DRY_RUN === '1';
const REPO = String(process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '').trim();
const TOKEN = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const SNAPSHOT = path.join(ROOT, 'snapshot-out', 'status.json');

if (!REPO) {
  console.error('缺少 GH_REPO / GITHUB_REPOSITORY');
  process.exit(1);
}
if (!TOKEN && !DRY_RUN) {
  console.error('缺少 GH_TOKEN / GITHUB_TOKEN');
  process.exit(1);
}

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const isOk = (x) => Boolean(x && x.status === 'ok');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (s) => String(s || '').replace(/x-access-token:[^\s@]+/g, 'x-access-token:***')
  .replace(/gh[pousr]_[A-Za-z0-9]+/g, '***');

function isComplete(j) {
  const power = Object.values(j.powerByGroup || {})[0];
  return isOk(j.alert) && isOk(power) && isOk(j.waterByScope?.local);
}

// 通过 GitHub API 读取权威内容，绕开 raw.githubusercontent.com 的 5 分钟边缘缓存。
// 缓存会让「线上快照年龄」被高估，从而误判为本机已经停推、错误覆盖完整数据。
async function readOnline() {
  const headers = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'kyiv-live-cloud-loop',
    'Cache-Control': 'no-cache',
  };
  // 公开仓库可匿名读取；有令牌时带上以避开匿名速率限制。
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const url = `https://api.github.com/repos/${REPO}/contents/status.json?ref=snapshot&_=${Date.now()}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        log(`读取线上快照失败：HTTP ${res.status}（第 ${attempt} 次）`);
        continue;
      }
      const text = await res.text();
      let j = JSON.parse(text);
      // contents API 在部分媒体类型下返回元数据对象而非文件正文。
      if (j && typeof j.content === 'string' && j.encoding === 'base64') {
        j = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      }
      const t = Date.parse(j.generatedAt);
      if (!Number.isFinite(t)) throw new Error('响应中缺少 generatedAt');
      return {
        generatedAt: j.generatedAt,
        complete: isComplete(j),
        ageMs: Date.now() - t,
      };
    } catch (err) {
      log(`读取线上快照异常：${err?.message || err}（第 ${attempt} 次）`);
    }
    await sleep(1500);
  }
  return null;
}

function publish(generatedAt, completeNow) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kyiv-cloud-'));
  try {
    copyFileSync(SNAPSHOT, path.join(tmp, 'status.json'));
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const git = (args) => {
      const r = spawnSync('git', [
        '-c', 'credential.helper=',
        '-c', `http.extraheader=AUTHORIZATION: basic ${basic}`,
        ...args,
      ], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) {
        throw new Error(`git ${args[0]} 失败：${redact(r.stderr).slice(0, 300)}`);
      }
      return r.stdout;
    };
    git(['init', '-q']);
    git(['checkout', '-q', '-b', 'snapshot']);
    git(['config', 'user.name', 'github-actions[bot]']);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    git(['add', 'status.json']);
    git(['commit', '-q', '-m', `[cloud] 数据快照 ${generatedAt}${completeNow ? '' : '（降级）'}`]);
    git(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
    git(['push', '-q', '--force', 'origin', 'snapshot']);
    log(`已发布 ${completeNow ? '完整' : '降级'}快照：${generatedAt}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function generate() {
  const r = spawnSync(process.execPath, ['scripts/build-snapshot.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, UPSTREAM_TIMEOUT: process.env.UPSTREAM_TIMEOUT || '12000' },
  });
  if (r.status !== 0) {
    log(`快照生成进程退出码 ${r.status}，本轮跳过。`);
    return false;
  }
  return true;
}

// 自我续期：GitHub 单个 job 最长 6 小时，且平台定时可能被大量丢弃。
// 在接近上限时直接用 GITHUB_TOKEN 触发本工作流的下一次运行，形成不依赖
// platform schedule 的接力链。GitHub 明确规定 workflow_dispatch 是
// 「GITHUB_TOKEN 触发的事件不再创建新 run」这一防递归规则的例外，因此可行。
async function dispatchNext() {
  if (DRY_RUN || !TOKEN) {
    log('DRY_RUN 或无令牌：跳过自我续期。');
    return;
  }
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/snapshot.yml/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'kyiv-live-cloud-loop',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main', inputs: {} }),
      signal: AbortSignal.timeout(15000),
    });
    log(`自我续期：HTTP ${res.status}${res.ok ? '，已排队下一棒' : `，${redact(await res.text()).slice(0, 200)}`}`);
  } catch (err) {
    log(`自我续期失败（平台定时仍可兜底）：${redact(err?.message || err)}`);
  }
}

async function roundOnce(index) {
  log(`第 ${index} 轮开始`);
  if (!generate()) return;
  const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const completeNow = isComplete(j);
  const online = await readOnline();
  const age = online ? Math.round(online.ageMs / 1000) : null;
  const publishIt = completeNow || Boolean(online && online.ageMs >= STALE_MS);
  log(`本轮完整=${completeNow}，线上年龄=${age === null ? '读取失败' : `${age}s`}，`
    + `线上完整=${online ? online.complete : '未知'}，发布=${publishIt}`);
  if (publishIt) {
    if (DRY_RUN) {
      log(`DRY_RUN：跳过实际推送（${completeNow ? '完整' : '降级'}快照 ${j.generatedAt}）`);
    } else {
      try {
        publish(j.generatedAt, completeNow);
      } catch (err) {
        log(`推送失败：${redact(err?.message || err)}`);
      }
    }
  }
}

async function main() {
  log(`云端循环启动：仓库=${REPO}，间隔=${PERIOD_MS / 60000} 分钟，`
    + `最长=${Math.round(MAX_MS / 60000)} 分钟，轮数=${ROUNDS || '不限'}，DRY_RUN=${DRY_RUN}`);
  const started = Date.now();
  let index = 0;
  let handedOff = false;
  for (;;) {
    index += 1;
    try {
      await roundOnce(index);
    } catch (err) {
      log(`第 ${index} 轮异常：${redact(err?.message || err)}`);
    }
    if (ROUNDS && index >= ROUNDS) {
      log('已达到指定轮数，退出。');
      return;
    }
    const remaining = MAX_MS - (Date.now() - started);
    // 剩余不足两轮时先排队下一棒，避免 job 被 6 小时上限强杀造成空窗。
    if (!handedOff && remaining <= 2 * PERIOD_MS) {
      handedOff = true;
      await dispatchNext();
    }
    if (remaining <= PERIOD_MS) {
      log('接近最长运行时长，退出并等待下一棒接力。');
      return;
    }
    // 对齐到 UTC 的 5 分钟刻度，使不同接力运行之间节奏连续。
    const next = Math.ceil((Date.now() + 1000) / PERIOD_MS) * PERIOD_MS;
    const wait = Math.max(1000, next - Date.now());
    log(`本轮结束，等待 ${Math.round(wait / 1000)} 秒至下一刻度。`);
    await sleep(wait);
  }
}

main().catch((err) => {
  console.error(`云端循环异常终止：${redact(err?.stack || err)}`);
  process.exit(1);
});
