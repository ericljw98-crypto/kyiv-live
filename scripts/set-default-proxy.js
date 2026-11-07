'use strict';

// 构建 APK 时可用环境变量 KYIV_DATA_URL 预置数据服务地址，装完即用。
// 例： KYIV_DATA_URL=http://192.168.1.10:8787 npm run build:apk
// 浏览器/PWA 模式不读取此配置，始终使用同源。
const fs = require('node:fs');
const path = require('node:path');

const value = String(process.env.KYIV_DATA_URL || '').trim().replace(/\/+$/, '');
if (value && !/^https?:\/\//i.test(value)) {
  console.error('KYIV_DATA_URL 必须以 http:// 或 https:// 开头');
  process.exit(1);
}
const file = path.join(__dirname, '..', 'www', 'config.json');
fs.writeFileSync(file, `${JSON.stringify({ proxyBase: value }, null, 2)}\n`);
console.log(value
  ? `已预置默认数据服务地址：${value}`
  : '未注入默认数据服务地址，APK 内需在「设置」中填写');
