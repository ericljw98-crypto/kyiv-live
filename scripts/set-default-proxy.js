'use strict';

// 构建 APK 时写入出厂数据标记。手机端固定读取 GitHub 静态快照，
// 不再提供本机/局域网实时服务地址，也不需要电脑常开。
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_URL = 'https://raw.githubusercontent.com/ericljw98-crypto/kyiv-live/snapshot/status.json';
const file = path.join(__dirname, '..', 'www', 'config.json');
fs.writeFileSync(file, `${JSON.stringify({
  dataMode: 'github',
  snapshotUrl: SNAPSHOT_URL,
}, null, 2)}\n`);
console.log(`已写入出厂数据标记：${SNAPSHOT_URL}`);
