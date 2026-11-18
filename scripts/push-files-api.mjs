#!/usr/bin/env node
// 通过 GitHub Git Data API 把本地文件提交到 main 分支。
// 用途：沙箱内 github.com 的 git 传输常被网络策略阻断，但 api.github.com 可用；
// 本脚本让「构建产物 / 源码补丁」仍能可靠落库，publish:github 再用 --skip-push 发布 Release。
//
// 用法：
//   GITHUB_TOKEN_FILE=/path/to/token node scripts/push-files-api.mjs \
//       -m "build: 更新 v1.7.1 APK" dist/kyiv-live-debug.apk dist/SHA256SUMS.txt
//
// 令牌只从环境变量或令牌文件读取，绝不写入日志、URL 或仓库。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'ericljw98-crypto';
const REPO = 'kyiv-live';
const BRANCH = 'main';
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

function fail(message) {
  console.error('\n提交中止：' + message + '\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const msgIdx = args.indexOf('-m');
const message = msgIdx >= 0 ? (args[msgIdx + 1] || '') : 'chore: 更新文件';
const files = args.filter((_, i) => i !== msgIdx && (msgIdx === -1 || i !== msgIdx + 1));
if (!files.length) fail('没有指定要提交的文件（路径相对仓库根目录）');
if (!message) fail('-m 之后的提交信息为空');

const tokenFile = process.env.GITHUB_TOKEN_FILE;
let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token && tokenFile && existsSync(tokenFile)) token = readFileSync(tokenFile, 'utf8').trim();
if (!token && existsSync(path.join(ROOT, '.ghtoken'))) token = readFileSync(path.join(ROOT, '.ghtoken'), 'utf8').trim();
if (!token) fail('缺少 GitHub 令牌：设置 GITHUB_TOKEN 或 GITHUB_TOKEN_FILE');

async function api(method, url, json) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'kyiv-live-push-api/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) fail(`${method} ${url.replace(BASE, '')} 失败（HTTP ${res.status}）：${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

async function main() {
  const ref = await api('GET', `${BASE}/git/ref/heads/${BRANCH}`);
  const head = ref.object.sha;
  const commit = await api('GET', `${BASE}/git/commits/${head}`);
  const baseTree = commit.tree.sha;
  console.log(`基线：${BRANCH} @ ${head.slice(0, 8)}`);

  const entries = [];
  for (const rel of files) {
    const abs = path.resolve(ROOT, rel);
    if (!existsSync(abs)) fail(`文件不存在：${rel}`);
    const buf = readFileSync(abs);
    const blob = await api('POST', `${BASE}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: rel.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ${rel} (${(buf.length / 1024).toFixed(1)} KB) → ${blob.sha.slice(0, 8)}`);
  }

  const tree = await api('POST', `${BASE}/git/trees`, { base_tree: baseTree, tree: entries });
  const next = await api('POST', `${BASE}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [head],
  });
  await api('PATCH', `${BASE}/git/refs/heads/${BRANCH}`, { sha: next.sha });
  console.log(`\n提交完成：${next.sha.slice(0, 12)}  ${message}`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${next.sha}`);
}

main().catch((err) => fail(err.message));
