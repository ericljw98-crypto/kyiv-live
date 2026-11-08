#!/usr/bin/env node
// 版本真源是根目录 version.json。本脚本把版本同步到所有编译产物，
// 避免 APK、网页、Gradle、Release 各说各话。零第三方依赖。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMeta, parseSemver, compareSemver, tagOf } from './version-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => writeFileSync(path.join(ROOT, p), s, 'utf8');
const stop = (message) => { console.error('版本同步中止：' + message); process.exit(1); };

const meta = JSON.parse(read('version.json'));
const invalid = validateMeta(meta);
if (invalid.length) stop('\n  - ' + invalid.join('\n  - '));

// 与上一次提交的版本对照：防止漏改版本号导致客户端收不到更新提示，
// 也防止 versionCode 回退造成 Android 拒绝覆盖安装。
function previousMeta() {
  try {
    const out = execFileSync('git', ['show', 'HEAD:version.json'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch { return null; }
}
const prev = previousMeta();
let historyLine = '';
if (prev && parseSemver(prev.version)) {
  const cmp = compareSemver(meta.version, prev.version);
  if (cmp < 0) stop(`${meta.version} 低于上一版 ${prev.version}，版本号不得回退`);
  if (cmp === 0) {
    if (meta.versionCode !== prev.versionCode) {
      stop(`版本号仍为 ${meta.version} 时 versionCode 必须保持 ${prev.versionCode}；重发同一版本只替换资产`);
    }
    historyLine = '注意：版本号未变更，重新构建不会触发客户端更新提示。';
  } else {
    if (!(meta.versionCode > prev.versionCode)) {
      stop(`发布 ${meta.version} 时 versionCode 必须大于上一版 ${prev.version} 的 ${prev.versionCode}`);
    }
    historyLine = `上一版 ${tagOf(prev.version)}（versionCode ${prev.versionCode}）→ ${tagOf(meta.version)}（versionCode ${meta.versionCode}）`;
  }
}

function patch(file, rules) {
  let text = read(file);
  for (const [re, value, label] of rules) {
    re.lastIndex = 0;
    if (!re.test(text)) {
      console.error(`${file}：未找到${label}，版本同步中止，请检查文件格式`);
      process.exit(1);
    }
    re.lastIndex = 0;
    text = text.replace(re, value);
  }
  write(file, text);
}

// 1. 网页与 APK 共用的一份版本描述；客户端更新检查也会读取它
write('www/version.json', `${JSON.stringify({
  version: meta.version,
  versionCode: meta.versionCode,
  releasedAt: meta.releasedAt,
  notes: meta.notes,
  repo: meta.repo,
  apkAsset: meta.apkAsset,
}, null, 2)}\n`);

// 2. 客户端编译期常量：APK 内当前版本不依赖网络，避免被服务端/SW 缓存覆盖
patch('www/app.js', [[
  /const BUILD_VERSION = '[^']*';/,
  `const BUILD_VERSION = '${meta.version}';`,
  'BUILD_VERSION 常量',
]]);

// 3. package.json
const pkg = JSON.parse(read('package.json'));
pkg.version = meta.version;
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

// 4. Android 版本号
patch('android/app/build.gradle', [
  [/versionCode \d+/, `versionCode ${meta.versionCode}`, 'versionCode'],
  [/versionName "[^"]*"/, `versionName "${meta.version}"`, 'versionName'],
]);

// 页面不写死版本：版本号随构建写入 www/app.js，
// 外链固定指向 /releases/latest，避免指向一个还没发布的 tag。
console.log(`版本已同步：${tagOf(meta.version)}（versionCode ${meta.versionCode}）`);
console.log('  www/version.json · www/app.js · package.json · android/app/build.gradle');
if (historyLine) console.log('  ' + historyLine);
