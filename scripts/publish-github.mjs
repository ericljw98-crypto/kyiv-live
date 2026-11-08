#!/usr/bin/env node
// 把本工程与编译好的 APK 发布到 GitHub 账号 ericljw98-crypto。
// 零第三方依赖。令牌只从环境变量读取，不写入任何文件、URL 或日志。
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateMeta, tagOf } from './version-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'ericljw98-crypto';
const REPO = 'kyiv-live';
const BRANCH = 'main';
const APK = path.join(ROOT, 'dist', 'kyiv-live-debug.apk');
const APK_NAME = 'kyiv-live-debug.apk';
const PUBLIC = process.argv.includes('--public');

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

function fail(message) {
  console.error('\n发布中止：' + message + '\n');
  process.exit(1);
}

// 版本真源是根目录 version.json；发布脚本与构建脚本读同一份文件。
// 校验放在令牌检查之前，本地无需凭据即可验证版本号与产物是否合规。
const META = JSON.parse(readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
const invalid = validateMeta(META);
if (invalid.length) fail('version.json 不符合版本号规范：\n  - ' + invalid.join('\n  - '));
const VERSION = META.version;
const TAG = tagOf(VERSION);
const APK_URL = `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${APK_NAME}`;
const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

if (!existsSync(APK)) fail(`未找到 ${APK}，请先运行 npm run build:apk。`);
// 校验和与 APK 必须一致，否则会出现「版本号升了、包还是旧的」这种最难排查的发布事故。
const SUMS = path.join(ROOT, 'dist', 'SHA256SUMS.txt');
if (!existsSync(SUMS)) fail(`未找到 ${SUMS}，请先运行 npm run build:apk。`);
const apkSha = createHash('sha256').update(readFileSync(APK)).digest('hex');
if (!readFileSync(SUMS, 'utf8').includes(apkSha)) {
  fail('dist/SHA256SUMS.txt 与 dist/kyiv-live-debug.apk 不匹配，请先重新构建再发布');
}

if (!token) {
  console.error([
    '',
    '缺少 GitHub 访问令牌。请按下面任一方式提供：',
    '',
    '  1. 在 https://github.com/settings/tokens 生成 classic PAT，勾选 repo 权限；',
    '  2. 在当前终端设置环境变量后重跑：',
    '',
    '     PowerShell:  $env:GITHUB_TOKEN = "<token>"; npm run publish:github',
    '     bash:        GITHUB_TOKEN=<token> npm run publish:github',
    '',
    '令牌不会写入仓库、日志或配置文件。',
    '',
  ].join('\n'));
  process.exit(1);
}

async function api(method, url, opts = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'kyiv-live-publisher/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function scrub(text) {
  return String(text || '').split(token).join('<redacted>');
}

function git(args) {
  const r = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) throw new Error(r.error.message);
  return r;
}

function need(result, action) {
  if (result.status !== 0) fail(`${action} 失败：${scrub(result.stderr || result.stdout).trim().slice(0, 600)}`);
  return (result.stdout || '').trim();
}

async function main() {
  console.log(`目标：github.com/${OWNER}/${REPO}（${PUBLIC ? '公开' : '私有'}）`);

  // 校验令牌归属，避免把工程推到错误账号。
  const me = await api('GET', 'https://api.github.com/user');
  if (!me.ok) fail(`无法校验令牌身份（HTTP ${me.status}）：${JSON.stringify(me.data).slice(0, 300)}`);
  const login = String(me.data.login || '');
  if (login.toLowerCase() !== OWNER.toLowerCase()) {
    fail(`令牌属于账号 ${login}，而目标账号是 ${OWNER}。请换成 ${OWNER} 的令牌。`);
  }
  console.log(`令牌已校验：${login}`);

  // 创建或复用仓库。
  let repo = await api('GET', BASE);
  if (repo.status === 404) {
    repo = await api('POST', 'https://api.github.com/user/repos', {
      json: {
        name: REPO,
        description: '基辅安全信息汇总 — Android APK 与源码',
        private: !PUBLIC,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      },
    });
    if (!repo.ok) {
      const detail = JSON.stringify(repo.data).slice(0, 300);
      const hint = repo.status === 403
        ? [
            '',
            '该令牌是 fine-grained 类型且缺少建库权限。任选其一：',
            '  a. 在 GitHub → Settings → Developer settings → Personal access tokens →',
            '     Fine-grained tokens → 编辑本令牌，在 Account permissions 中把',
            '     「Repository creation」设为 Read and write，保存后重跑本脚本；',
            '  b. 换用 classic PAT（ghp_ 开头，勾选 repo），一条命令即可全自动完成；',
            '  c. 在 https://github.com/new 手动创建名为 kyiv-live 的私有空仓库，',
            '     不要勾选 Initialize with README，脚本会自动复用并继续推送与发布。',
            '',
          ].join('\n')
        : '';
      fail(`创建仓库失败（HTTP ${repo.status}）：${detail}${hint}`);
    }
    console.log('仓库已创建');
  } else if (!repo.ok) {
    fail(`读取仓库失败（HTTP ${repo.status}）：${JSON.stringify(repo.data).slice(0, 300)}`);
  } else {
    console.log('仓库已存在，复用');
    if (PUBLIC && repo.data.private) {
      const patched = await api('PATCH', BASE, { json: { private: false } });
      console.log(patched.ok ? '可见性已改为公开' : `可见性修改失败：HTTP ${patched.status}`);
    }
  }

  // 本地仓库与远程地址。
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) need(git(['init', '-b', BRANCH]), 'git init');
  if (git(['rev-parse', 'HEAD']).status !== 0) fail('本地仓库尚无提交，请先执行一次 git commit。');
  const currentBranch = need(git(['rev-parse', '--abbrev-ref', 'HEAD']), '读取分支');
  const remotes = git(['remote']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const cleanUrl = `https://github.com/${OWNER}/${REPO}.git`;
  if (remotes.includes('origin')) {
    need(git(['remote', 'set-url', 'origin', cleanUrl]), '设置远程地址');
  } else {
    need(git(['remote', 'add', 'origin', cleanUrl]), '添加远程地址');
  }

  const dirty = git(['status', '--porcelain']).stdout.trim();
  if (dirty) console.log('提示：工作区存在未提交改动，本次推送只包含已提交内容。');

  // 推送。git over HTTPS 只接受 Basic 认证，Bearer 会退化到交互式用户名输入。
  // 令牌只出现在本次进程参数中，不写入 .git/config，也不进入日志。
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  let push = git([
    '-c', 'credential.helper=',
    '-c', `http.extraheader=AUTHORIZATION: basic ${basic}`,
    'push', '-u', 'origin', `HEAD:refs/heads/${BRANCH}`,
  ]);
  if (push.status !== 0) {
    // 部分 Git 版本对 extraheader 处理不一致，回退为一次性认证 URL。
    const authUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${OWNER}/${REPO}.git`;
    push = git(['-c', 'credential.helper=', 'push', authUrl, `HEAD:refs/heads/${BRANCH}`]);
  }
  if (push.status !== 0) {
    fail(`推送失败：${scrub(push.stderr || push.stdout).trim().slice(0, 800)}\n当前分支 ${currentBranch}。若远程已有不同历史，请自行合并后再发布，脚本不会强制覆盖。`);
  }
  console.log(`代码已推送到 ${BRANCH}`);

  // 创建或复用 Release。
  let rel = await api('GET', `${BASE}/releases/tags/${TAG}`);
  if (rel.status === 404) {
    rel = await api('POST', `${BASE}/releases`, {
      json: {
        tag_name: TAG,
        target_commitish: BRANCH,
        name: `基辅安全信息汇总 ${TAG}`,
        body: [
          '基辅安全信息汇总的 Android 安装包（debug 签名）。',
          '',
          `本次更新：${META.notes || '常规更新'}`,
          '',
          '应用会在启动时、回到前台时与每 30 分钟检查本 Release 的最新版本并提示更新；',
          '提示不会自动下载或安装，需手动打开安装包覆盖安装，已有设置会保留。',
          'v1.0.0 及更早的安装包不含更新检查功能，须先手动安装一次本版本。',
          '',
          `直链：${APK_URL}`,
          '安装前请阅读 README.md 中的「数据边界」与「本地运行」章节。',
          'APK 默认从 GitHub 静态快照读取数据，手机无需电脑常开，也不需要设置任何局域网地址。',
          '',
          '校验和见仓库内 dist/SHA256SUMS.txt。',
        ].join('\n'),
        draft: false,
        prerelease: false,
      },
    });
    if (!rel.ok) fail(`创建 Release 失败（HTTP ${rel.status}）：${JSON.stringify(rel.data).slice(0, 400)}`);
    console.log(`Release ${TAG} 已创建`);
  } else if (!rel.ok) {
    fail(`读取 Release 失败（HTTP ${rel.status}）：${JSON.stringify(rel.data).slice(0, 300)}`);
  } else {
    console.log(`Release ${TAG} 已存在，复用`);
    console.log('提示：同一版本重发只会替换资产，客户端不会把它识别为更新；若需要用户收到提示，请先提升 version.json 的 version 与 versionCode 并重新构建。');
  }

  // 同名资产先删除，保证可重复执行。
  for (const asset of rel.data.assets || []) {
    if (asset.name === APK_NAME) {
      const del = await api('DELETE', `${BASE}/releases/assets/${asset.id}`);
      if (!del.ok) console.log(`警告：旧资产删除失败（HTTP ${del.status}），继续尝试上传。`);
    }
  }

  const buf = readFileSync(APK);
  const sha = createHash('sha256').update(buf).digest('hex');
  const upload = await api(
    'POST',
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.data.id}/assets?name=${APK_NAME}`,
    {
      body: buf,
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': String(buf.length),
      },
    },
  );
  if (!upload.ok) fail(`上传 APK 失败（HTTP ${upload.status}）：${JSON.stringify(upload.data).slice(0, 400)}`);

  console.log([
    '',
    '发布完成',
    `  仓库：    https://github.com/${OWNER}/${REPO}`,
    `  Release： ${rel.data.html_url}`,
    `  APK：     ${upload.data.browser_download_url}`,
    `  大小：    ${(buf.length / 1024 / 1024).toFixed(2)} MB`,
    `  SHA-256： ${sha}`,
    '',
    ...(PUBLIC
      ? [
          '仓库为公开，Release 资产可免登录下载，手机浏览器打开上面的 APK 链接即可安装。',
          '注意：源码与 git 历史中含默认关注地址，公开后无法撤回已被抓取的副本。',
        ]
      : [
          '私有仓库的资产链接需要登录 GitHub 才能下载；若要在手机上直接安装，',
          '可从 Release 页面在已登录的浏览器下载，或加 --public 重新运行本脚本改为公开。',
        ]),
    '',
  ].join('\n'));
}

main().catch((err) => fail(err.message));
