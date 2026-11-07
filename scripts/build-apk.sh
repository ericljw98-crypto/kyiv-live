#!/usr/bin/env bash
# 需要：JDK 17+、ANDROID_HOME（或 ANDROID_SDK_ROOT）、已执行过 setup-android.sh
# 产物：kyiv-live-debug.apk（debug 签名，可直接侧载安装）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d android ]; then
  echo "缺少 android/ 工程，请先运行： bash scripts/setup-android.sh" >&2
  exit 1
fi
if ! command -v java >/dev/null 2>&1; then
  echo "未找到 java。请安装 JDK 17+ 并加入 PATH。" >&2
  exit 1
fi
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo "未设置 ANDROID_HOME。请指向 Android SDK 目录。" >&2
  exit 1
fi

echo "[1/4] 同步版本、生成图标、写入默认地址并同步资源"
node scripts/write-version.mjs
node scripts/make-icons.js
node scripts/set-default-proxy.js
npx cap sync android
node scripts/patch-android.js

echo "[2/4] Gradle 构建 debug APK"
cd android
chmod +x ./gradlew
./gradlew assembleDebug --no-daemon

echo "[3/4] 复制产物并生成分发校验和"
cp app/build/outputs/apk/debug/app-debug.apk ../kyiv-live-debug.apk
cd ..
node scripts/dist-manifest.mjs

echo "[4/4] 完成"
echo "APK 已生成： $(pwd)/kyiv-live-debug.apk"
echo "安装到手机： adb install -r kyiv-live-debug.apk"
