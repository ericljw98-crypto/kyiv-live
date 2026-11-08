#!/usr/bin/env node
'use strict';

// 把人工校订过的公开报道索引复制进 www/，作为 APK 内的离线兜底。
// 线上快照更新后客户端优先使用快照里的版本；快照尚未带该字段时
// （例如只更新了 APK、还没推送新快照），仍能显示这一份已校订索引。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'data', 'aftermath.json');
const dst = path.join(ROOT, 'www', 'aftermath.json');
const j = JSON.parse(readFileSync(src, 'utf8'));
if (j.schema !== 1 || !Array.isArray(j.items)) throw new Error('data/aftermath.json 格式不正确');
writeFileSync(dst, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
console.log(`已内置袭击后果索引：${j.items.length} 条 → www/aftermath.json`);
