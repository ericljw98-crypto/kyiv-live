#!/usr/bin/env node
// 发布前闸门：确认 APK 的签名证书指纹与本仓库固定的期望值一致。
// 这是「证书身份」校验，与 dist/SHA256SUMS.txt 的「文件完整性」校验互补，二者不能互相替代：
// 文件哈希只能证明下载过程没被篡改，只有证书指纹能证明这个包确实用我方私钥签过。
//
// 用法：node scripts/verify-apk-signature.mjs [apk 路径，默认 dist/kyiv-live-debug.apk]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APK = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : path.join(ROOT, 'dist', 'kyiv-live-debug.apk');
const FINGERPRINT = path.join(ROOT, 'signing', 'fingerprint.sha256');

function fail(message) {
  console.error('\n签名证书校验未通过：' + message + '\n');
  process.exit(1);
}

if (!existsSync(APK)) fail(`未找到 ${APK}，请先构建 APK`);
if (!existsSync(FINGERPRINT)) fail(`缺少期望指纹文件 ${FINGERPRINT}`);
const expected = readFileSync(FINGERPRINT, 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .find((s) => /^[0-9a-f]{64}$/i.test(s));
if (!expected) fail('fingerprint.sha256 中没有找到 64 位十六进制指纹');

function findApksigner() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, '/opt/android-sdk'].filter(Boolean);
  for (const root of roots) {
    const bt = path.join(root, 'build-tools');
    if (!existsSync(bt)) continue;
    for (const version of readdirSync(bt).sort().reverse()) {
      const candidate = path.join(bt, version, 'apksigner');
      if (existsSync(candidate)) return candidate;
    }
  }
  const which = spawnSync('which', ['apksigner'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : null;
}

const tool = findApksigner();
if (!tool) {
  fail([
    '未找到 apksigner（Android SDK build-tools）。',
    '请安装 SDK 或设置 ANDROID_HOME；确需跳过时可在发布脚本加 --skip-signature-check。',
  ].join('\n  '));
}

const result = spawnSync(tool, ['verify', '--verbose', '--print-certs', APK], { encoding: 'utf8' });
const output = (result.stdout || '') + '\n' + (result.stderr || '');
if (result.status !== 0 || !/^Verifies\s*$/m.test(output)) {
  fail(`apksigner 未通过验证（exit ${result.status}）：\n${output.trim().slice(0, 800)}`);
}

const match = output.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f]{64})/i);
if (!match) fail('apksigner 输出中未找到 Signer #1 certificate SHA-256 digest');
const actual = match[1].toLowerCase();
if (actual !== expected.toLowerCase()) {
  fail([
    'APK 签名证书与官方证书不一致，拒绝发布。',
    `  期望：${expected.toLowerCase()}`,
    `  实际：${actual}`,
    '  可能原因：用了另一把 keystore、误用了 debug 签名、或私钥被替换。',
    '  请确认 build-apk.sh 加载的 KYIV_KEYSTORE 正确后重新构建。',
  ].join('\n'));
}

const v2 = /Verified using v2 scheme[^:]*:\s*true/i.test(output);
if (!v2) fail('APK 未启用 v2 签名（minSdk 24 要求 v2）');
const v3 = /Verified using v3 scheme[^:]*:\s*true/i.test(output);
console.log([
  `签名证书校验通过：${actual}`,
  `  签名方案：v2 ${v2 ? '✓' : '✗'} / v3 ${v3 ? '✓' : '✗（建议启用以支持未来密钥轮换）'}`,
  `  依据：${path.relative(ROOT, FINGERPRINT)}`,
].join('\n'));
