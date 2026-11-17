#!/usr/bin/env node
'use strict';

// 把 data/reports.json（早午报正文快照）提交并推送到 main 分支。
// 供「早午报推送」自动化在 GitHub 连接器不可用时作为兜底写入路径：
//
//   GITHUB_TOKEN=<classic PAT> node scripts/push-reports.mjs
//
// 只提交 data/reports.json 一个文件；无变化时直接退出，不产生空提交。
// 令牌只经环境变量传入，不写入任何文件。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();

if (!token) {
  console.error('缺少 GITHUB_TOKEN。请设置具备 repo 权限的 classic PAT 后重跑。');
  process.exit(1);
}

const git = (args) => execFileSync('git', args, {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
});

git(['config', 'user.name', 'ericljw98-crypto']);
git(['config', 'user.email', 'ericljw98-crypto@users.noreply.github.com']);
git(['add', 'data/reports.json']);

const staged = git(['diff', '--cached', '--name-only']).trim();
if (!staged) {
  console.log('data/reports.json 无变化，跳过提交。');
  process.exit(0);
}

git(['commit', '-q', '-m', `reports: 更新早午报 ${new Date().toISOString()}`]);
const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
git(['-c', 'credential.helper=',
  '-c', `http.extraheader=AUTHORIZATION: basic ${basic}`,
  'push', '-q', 'origin', 'HEAD:refs/heads/main']);
console.log('已推送 data/reports.json 到 main 分支。');
