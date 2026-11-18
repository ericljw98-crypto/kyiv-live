#!/usr/bin/env bash
# 需要：JDK 21+（Capacitor Android 模块是 sourceCompatibility 21，JDK 17 会报 invalid source release）、
#       ANDROID_HOME（或 ANDROID_SDK_ROOT）、已执行过 setup-android.sh
#       release 签名凭据：/root/kyiv-live-secrets/keystore.env（仓库外，绝不提交）
# 产物：kyiv-live-debug.apk（沿用历史文件名以兼容旧版客户端的资产精确匹配；
#       自 v1.8.0 起内容改为固定 release keystore 签名，不再是 debug 签名）
set -euo pipefail
cd "$(dirname "$0")/.."

# 团队任务沙箱内已装好 JDK 21 与 Android SDK：存在时自动启用，
# 让 `npm run build:apk` 开箱即用，无需每次手动 export 四个环境变量。
if [ -x /usr/lib/jvm/java-21-openjdk-amd64/bin/java ]; then
  # Capacitor 要求 source 21；沙箱预设的 JAVA_HOME 可能指向 JDK 17/20，
  # 因此只要本机装了 JDK 21 就优先切过去（其他机器无此路径时保持用户设置）。
  export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
  export PATH="$JAVA_HOME/bin:$PATH"
fi
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] && [ -d /opt/android-sdk/platforms ]; then
  export ANDROID_HOME=/opt/android-sdk
  export ANDROID_SDK_ROOT=/opt/android-sdk
fi

if [ ! -d android ]; then
  echo "缺少 android/ 工程，请先运行： bash scripts/setup-android.sh" >&2
  exit 1
fi
if ! command -v java >/dev/null 2>&1; then
  echo "未找到 java。请安装 JDK 21+ 并加入 PATH。" >&2
  exit 1
fi
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo "未设置 ANDROID_HOME。请指向 Android SDK 目录。" >&2
  exit 1
fi

# release 签名凭据：优先使用调用方注入的环境变量，其次读取团队任务沙箱内
# 位于仓库之外的凭据文件。私钥与密码绝不进入版本库、日志或命令行参数。
SECRET_ENV=/root/kyiv-live-secrets/keystore.env
if [ -z "${KYIV_KEYSTORE:-}" ] && [ -r "$SECRET_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRET_ENV"
  set +a
fi
if [ -z "${KYIV_KEYSTORE:-}" ] || [ ! -r "${KYIV_KEYSTORE}" ]; then
  echo "缺少 release 签名凭据：请设置 KYIV_KEYSTORE 等环境变量，或放置 $SECRET_ENV" >&2
  echo "私钥绝不入库；生成方式见 README.md 的「安装包签名」章节。" >&2
  exit 1
fi

echo "[1/5] 同步版本、词库、图标、默认地址并同步资源"
node scripts/write-version.mjs
node scripts/sync-zh.js
node scripts/sync-aftermath.mjs
node scripts/make-icons.js
node scripts/set-default-proxy.js
npx cap sync android
node scripts/patch-android.js

echo "[2/5] Gradle 构建 release APK（固定 release keystore 签名）"
cd android
chmod +x ./gradlew
./gradlew assembleRelease --no-daemon

echo "[3/5] 复制产物并生成分发校验和"
cp app/build/outputs/apk/release/app-release.apk ../kyiv-live-debug.apk
cd ..
node scripts/dist-manifest.mjs

echo "[4/5] 校验签名证书指纹（发布前闸门）"
node scripts/verify-apk-signature.mjs

echo "[5/5] 完成"
echo "APK 已生成： $(pwd)/kyiv-live-debug.apk（release 签名）"
echo "安装到手机： adb install -r kyiv-live-debug.apk"
echo "注意：v1.7.2 及更早版本为 debug 签名，升级需先卸载旧版再安装。"
