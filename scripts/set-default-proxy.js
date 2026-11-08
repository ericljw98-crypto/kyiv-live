'use strict';

// 构建 APK 时写入出厂数据地址。默认指向 GitHub 静态快照，装完即用，
// 不需要电脑常开或与手机同网。仅当显式传入 KYIV_DATA_URL 时才改用其他地址：
//   KYIV_DATA_URL=http://192.168.1.10:8787 npm run build:apk   （本机实时服务）
// 浏览器/PWA 模式不读取此配置，默认始终使用同源实时数据。
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_URL = 'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json';
const value = String(process.env.KYIV_DATA_URL || SNAPSHOT_URL).trim().replace(/\/+$/, '');
if (!/^https?:\/\//i.test(value)) {
  console.error('KYIV_DATA_URL 必须以 http:// 或 https:// 开头');
  process.exit(1);
}
const isSnapshot = /^https:\/\/(?:raw\.githubusercontent\.com|[a-z0-9-]+\.github\.io)\//i.test(value);
const file = path.join(__dirname, '..', 'www', 'config.json');
fs.writeFileSync(file, `${JSON.stringify({
  proxyBase: value,
  dataMode: isSnapshot ? 'github' : 'local',
}, null, 2)}\n`);
console.log(`已预置出厂数据地址：${value}（${isSnapshot ? '远端 GitHub 快照' : '本机实时服务'}）`);
