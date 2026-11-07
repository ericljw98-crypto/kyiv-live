'use strict';

// 把服务端本地化词库同步到前端 www/。词库只有一份真源（server/zh.js），
// 浏览器侧仅作显示前兜底，避免两份词典各自漂移。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'server', 'zh.js');
const dst = path.join(root, 'www', 'zh.js');
const body = fs.readFileSync(src, 'utf8');
const header = '// 由 node scripts/sync-zh.js 从 server/zh.js 自动生成，请勿直接编辑。\n';
fs.writeFileSync(dst, header + body, 'utf8');
console.log(`已同步本地化词库：www/zh.js（${Buffer.byteLength(body)} 字节）`);
