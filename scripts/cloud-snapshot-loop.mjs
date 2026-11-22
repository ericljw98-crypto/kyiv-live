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
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
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
  // 用每个分组自带的 status 判定，而不是只看第一个分组。
  // 之前写的是取「第一个分组」再判断，碰到分组顺序变化或该分组缺失就会误判为不完整，
  // 进而整轮拒发，快照时间戳一并停更（线上曾出现长时间卡在同一分钟）。
  // stale 表示本机上游失败、已沿用线上最近一轮的停电计划，这类数据可用但不代表实时。
  const powers = Object.values(j.powerByGroup || {});
  const powerOk = powers.length > 0 && powers.every((p) => isOk(p));
  // 只要有一张数据卡是实时拿到的，就不算整份停摆：停在 stale/降级状态也应继续发布新时间戳，
  // 让用户看到的最新数据不至于连着几分钟一模一样。全部停滞才判定为不可发布。
  const freshElsewhere = [j.alert, j.waterByScope?.local, j.aftermath, j.news].some(isOk);
  return isOk(j.alert) && powerOk && isOk(j.waterByScope?.local) && (powers.every((p) => !p.stale) || freshElsewhere);
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
        aftermath: j.aftermath || null,
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
  // 单轮构建加硬超时：之前用 spawnSync 无上限，一处上游卡住就会让整个 job 静默挂住，
  // 期间一条快照都发不出去。超时即放弃本轮，下一轮照常开始。
  const r = spawnSync(process.execPath, ['scripts/build-snapshot.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: Number(process.env.BUILD_TIMEOUT_MS || 180000),
    killSignal: 'SIGKILL',
    env: { ...process.env, UPSTREAM_TIMEOUT: process.env.UPSTREAM_TIMEOUT || '12000' },
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    log('本轮构建超时（已强杀），跳过。');
    return false;
  }
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

// 早午报的权威数据来自 main 分支 data/reports.json。走 Contents API 而非 raw CDN，
// 避免边缘缓存把新增类别（涉华涉台涉日）过滤成旧的两类快照；同时不依赖
// build-snapshot.mjs 的版本，接力中的旧进程残留也不会让新类别丢失。
const KIND_LABEL = { morning: '早报', noon: '午报', china: '涉华涉台涉日' };
const MAX_REPORTS = 5;

async function authoritativeReports() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kyiv-live-cloud-loop',
    'Cache-Control': 'no-cache',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const url = `https://api.github.com/repos/${REPO}/contents/data/reports.json?ref=main&_=${Date.now()}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const d = await res.json();
    if (typeof d?.content !== 'string') return null;
    const j = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
    if (!j || j.schema !== 1 || !Array.isArray(j.items)) return null;
    const items = j.items
      .filter((it) => it && Object.prototype.hasOwnProperty.call(KIND_LABEL, it.kind)
        && typeof it.content === 'string' && it.content.trim())
      .map((it) => ({
        kind: it.kind,
        label: KIND_LABEL[it.kind],
        date: String(it.date || ''),
        title: String(it.title || ''),
        fileName: String(it.fileName || ''),
        fileTime: String(it.fileTime || ''),
        content: String(it.content).slice(0, 20000),
      }))
      .sort((a, b) => (Date.parse(b.fileTime) || 0) - (Date.parse(a.fileTime) || 0))
      .slice(0, MAX_REPORTS);
    return { status: items.length ? 'ok' : 'empty', generatedAt: String(j.generatedAt || ''), items };
  } catch (err) {
    log(`读取早午报权威数据失败：${redact(err?.message || err)}`);
    return null;
  }
}

// 进程内状态：记录本轮实际发布的内容，供退出时输出一段「自检摘要」。
// 为什么需要：job 中途被取消/超时时，Actions 日志不可读（HTTP 404），
// 只能从「最后一次该出现的日志」反推卡在哪一步。摘要落在日志末尾，
// 即使只看到截断的尾巴也能判断构建是否真的产出过新数据。
const state = { published: null, rounds: 0, failures: [] };

async function roundOnce(index) {
  log(`第 ${index} 轮开始`);
  state.rounds = index;
  if (!generate()) { state.failures.push(`第 ${index} 轮构建失败/超时`); return; }
  const j = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const reports = await authoritativeReports();
  if (reports) {
    j.reports = reports;
    writeFileSync(SNAPSHOT, `${JSON.stringify(j)}\n`, 'utf8');
    log(`早午报已按权威数据校正：${reports.items.length} 篇`);
  } else {
    log('早午报权威数据不可用，保留快照生成器结果');
  }
  const completeNow = isComplete(j);
  const online = await readOnline();
  const age = online ? Math.round(online.ageMs / 1000) : null;
  // 发布与否只看「本轮自己拿到了什么」，不再拿线上的完整状态做保护闸门。
  // 旧逻辑要求线上快照「不完整」才肯覆盖：一旦线上是完整快照、而本轮恰好碰上停电源 403
  // （complete=false），就会一直拒发——线上实测出现时间戳、要闻、袭击后果集体停在原地。
  // 现在各模块用自带的 stale / cached 字段如实标注数据新鲜度，发布节奏不再被完整性拦住。
  let publishIt = true;
  // 「防退化」闸门：新快照的袭击后果若退化成缺发射数（上游一轮抓取不全就会这样），
  // 而线上刚发布的同一日期条目是完整的，则拒绝发布这份退化版本，继续沿用线上那份。
  // 否则每轮都会在 186/161 与 148/117 之间来回抖动，用户每次刷新看到的数字都不一样。
  if (regressedAftermath(j, online)) {
    publishIt = false;
    log('本轮袭击后果弱于线上同日期条目（数字回退或跨夜拼接），拒绝发布以免数据回退');
  }
  log(`本轮完整=${completeNow}，线上年龄=${age === null ? '读取失败' : `${age}s`}，`
    + `线上完整=${online ? online.complete : '未知'}，发布=${publishIt}`);
  // 发布前留一份描述，便于轮末自检「本轮到底发布了什么」。
  state.published = {
    generatedAt: j.generatedAt,
    complete: completeNow,
    aftermathStatus: j.aftermath ? String(j.aftermath.status || '') : '',
    aftermathDrone: j.aftermath?.items?.[0] ? String(j.aftermath.items[0].drones || '') : '',
    newsStatus: j.news ? String(j.news.status || '') : '',
    round: index,
  };
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

function summarize() {
  const p = state.published;
  if (!p) {
    log(`自检摘要：共 ${state.rounds} 轮，没有任何一轮成功产出快照。${state.failures.join('；')}`);
    return;
  }
  log(`自检摘要：共 ${state.rounds} 轮，最后发布第 ${p.round} 轮（${p.generatedAt}）`
    + `，完整=${p.complete}，袭击后果=${p.aftermathStatus || '无'} / ${p.aftermathDrone || '无数字'}`
    + `，要闻=${p.newsStatus || '无'}`);
  if (state.failures.length) log(`自检摘要：失败轮次 ${state.failures.join('；')}`);
}

// 袭击后果「退化」判定：同一日期下，新结果比线上结果少了发射总数（或拦截数），即视为退化。
// 只比较同日期的条目——跨日时线上那份本来就是旧闻，不值得保护。
function aftermathScore(sec) {
  const it = sec && Array.isArray(sec.items) ? sec.items[0] : null;
  if (!it) return null;
  const d = String(it.drones || '');
  const m = String(it.missiles || '');
  // 解析出具体数字：只有数字才能判断「回退」与「跨夜拼接」（拦截数比发射数还旧一轮）。
  const num = (s, re) => { const x = String(s || '').match(re); return x ? Number(String(x[1]).replace(/,/g, '')) : null; };
  return {
    date: String(it.date || ''),
    launchD: num(d, /发射\s*([\d,]+)\s*架/),
    interD: num(d, /拦截\s*([\d,]+)\s*架/),
    launchM: num(m, /发射\s*([\d,]+)\s*枚/),
    interM: num(m, /拦截\s*([\d,]+)\s*枚/),
  };
}

// 与 server/aftermath.js 的 isRegression 同口径：拦截数只在「与发射数同批取得」时才算强，
// 否则会出现「发射 148（拦截 117）」这种两个数字来自不同夜晚的拼接标题。
function regressedAftermath(j, online) {
  const a = aftermathScore(j.aftermath);
  const b = aftermathScore(online && online.aftermath);
  if (!a || !b || a.date !== b.date) return false;
  if (a.launchD == null && a.launchM == null) return false; // 线上本来就没有发射数，无可回退
  if (b.launchD == null && b.launchM == null) return true;
  if (a.launchD != null && b.launchD != null && b.launchD < a.launchD) return true;
  if (a.launchM != null && b.launchM != null && b.launchM < a.launchM) return true;
  // 跨夜拼接：本轮发射数与线上一致，但拦截数突然与发射数不成比例（大于发射数）→ 视为坏数据。
  if (b.interD != null && b.launchD != null && b.interD > b.launchD) return true;
  return false;
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
      summarize();
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
      summarize();
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
