'use strict';

// Android 9+ 默认禁止明文 HTTP。APK 需要访问局域网内的 Node 数据服务
// （例如 http://192.168.1.10:8787），因此补上 usesCleartextTraffic。
// 幂等：重复运行不会重复插入。
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(file)) {
  console.log('android/ 工程尚未创建，跳过明文流量补丁');
  process.exit(0);
}
let xml = fs.readFileSync(file, 'utf8');
if (/android:usesCleartextTraffic/.test(xml)) {
  console.log('usesCleartextTraffic 已配置');
  process.exit(0);
}
if (!/<application\b/.test(xml)) {
  console.error('未找到 <application> 标签，请检查 AndroidManifest.xml');
  process.exit(1);
}
xml = xml.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
fs.writeFileSync(file, xml);
console.log('已加入 android:usesCleartextTraffic="true"');
