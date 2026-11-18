#!/usr/bin/env bash
# 需要：JDK 21+（Capacitor Android 模块是 sourceCompatibility 21，JDK 17 会报 invalid source release）、
#       ANDROID_HOME（或 ANDROID_SDK_ROOT）、已执行过 setup-android.sh
# 产物：kyiv-live-debug.apk（debug 签名，可直接侧载安装）
set -euo pipefail
cd "$(dirname "$0")/.."

# 团队任务沙箱内已装好 JDK 21 与 Android SDK：存在时自动启用，
# 让 `npm run build:apk` 开箱即用，无需每次手动 export 四个环境变量。
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/lib/jvm/java-21-openjdk-amd64/bin/java ]; then
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
  echo "未找到 java。请安装 JDK 17+ 并加入 PATH。" >&2
  exit 1
fi
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo "未设置 ANDROID_HOME。请指向 Android SDK 目录。" >&2
  exit 1
fi

echo "[1/4] 同步版本、词库、图标、默认地址并同步资源"
node scripts/write-version.mjs
node scripts/sync-zh.js
node scripts/sync-aftermath.mjs
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
