#!/usr/bin/env node
// 把刚构建的 APK 复制到 dist/，并生成 SHA256SUMS.txt。
// 根目录的 APK 供本机数据服务的 /install 下载，dist/ 内的是发布到 GitHub Release 的同一份文件。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'kyiv-live-debug.apk';
const src = path.join(ROOT, NAME);
const dir = path.join(ROOT, 'dist');
const dst = path.join(dir, NAME);

const buf = readFileSync(src);
mkdirSync(dir, { recursive: true });
copyFileSync(src, dst);
const sha = createHash('sha256').update(buf).digest('hex');
writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${sha} *${NAME}\n`, 'utf8');

console.log(`分发产物已更新：dist/${NAME}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
console.log(`SHA-256：${sha}`);
