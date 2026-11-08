'use strict';

// Capacitor 以 http://localhost 加载打包在 APK 内的网页资源，Android 9+
// 默认禁止明文 HTTP，因此保留 usesCleartextTraffic。手机端对外只访问
// HTTPS 的 GitHub 快照与 Release，不再连接任何局域网数据服务。
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
