// 版本号规范的唯一可执行定义。write-version.mjs 与 publish-github.mjs 共用，
// README.md 的「版本号规范」章节是这份规则的自然语言说明，二者必须一致。
//
// 面向用户与 GitHub tag：vMAJOR.MINOR.PATCH，三段十进制整数，无前导零、无后缀。
// 内部构建号：versionCode 是严格递增的正整数发布序号，不编码版本语义。

export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const MAX_SEGMENT = 999;
export const ANDROID_MAX_VERSION_CODE = 2100000000;
export const REPO = 'ericljw98-crypto/kyiv-live';
export const APK_ASSET = 'kyiv-live-debug.apk';

// 返回的数组可直接逐段比较；不符合规范时返回 null，调用方必须显式处理，
// 不能把「无法比较」当作「相等」，否则会静默放过错误版本号。
export function parseSemver(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  if (!VERSION_RE.test(text)) return null;
  const parts = text.split('.').map(Number);
  return parts.every((n) => n <= MAX_SEGMENT) ? parts : null;
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

export function tagOf(version) {
  return `v${version}`;
}

export function validateMeta(meta) {
  const errors = [];
  if (!parseSemver(meta.version)) {
    errors.push(`version 必须是无后缀、无前导零的三段式数字（每段 ≤ ${MAX_SEGMENT}），例如 1.2.0；当前为 ${JSON.stringify(meta.version)}`);
  }
  if (!Number.isInteger(meta.versionCode) || meta.versionCode < 1) {
    errors.push('versionCode 必须是 ≥ 1 的整数');
  } else if (meta.versionCode > ANDROID_MAX_VERSION_CODE) {
    errors.push(`versionCode 超过 Android 上限 ${ANDROID_MAX_VERSION_CODE}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.releasedAt ?? ''))) {
    errors.push('releasedAt 必须是 YYYY-MM-DD');
  }
  const notes = String(meta.notes ?? '').trim();
  if (notes.length < 8) {
    errors.push('notes 至少 8 个字符：更新提示条与 Release 说明会直接展示它');
  } else if (notes.length > 120) {
    errors.push('notes 不得超过 120 个字符，否则提示条会被截断');
  }
  if (meta.repo !== REPO) {
    errors.push(`repo 必须是 ${REPO}，客户端的更新检查地址写死了该仓库`);
  }
  if (meta.apkAsset !== APK_ASSET) {
    errors.push(`apkAsset 必须保持 ${APK_ASSET}，否则客户端找不到下载资产`);
  }
  return errors;
}
