#!/usr/bin/env node
// 版本真源是根目录 version.json。本脚本把版本同步到所有编译产物，
// 避免 APK、网页、Gradle、Release 各说各话。零第三方依赖。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => writeFileSync(path.join(ROOT, p), s, 'utf8');

const meta = JSON.parse(read('version.json'));
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(meta.version)) {
  console.error('version.json 中的 version 必须是三段式语义化版本，例如 1.1.0');
  process.exit(1);
}
if (!Number.isInteger(meta.versionCode) || meta.versionCode < 1) {
  console.error('version.json 中的 versionCode 必须是正整数，且每次发布递增');
  process.exit(1);
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

// 安装页不写死版本：版本号由服务端注入 __APP_VERSION__，
// 外链固定指向 /releases/latest，避免指向一个还没发布的 tag。
console.log(`版本已同步：${meta.version}（versionCode ${meta.versionCode}）`);
console.log('  www/version.json · www/app.js · package.json · android/app/build.gradle');
