#!/usr/bin/env bash
# 在装有 JDK 17+ 与 Android SDK 的机器上执行，生成 Capacitor Android 工程。
# 用法： npm run setup:android   或   bash scripts/setup-android.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] 安装 Capacitor 依赖"
npm install

echo "[2/5] 生成图标并写入默认数据服务地址"
node scripts/make-icons.js
node scripts/set-default-proxy.js

echo "[3/5] 创建 android/ 工程（已存在则跳过）"
if [ ! -d android ]; then
  npx cap add android
else
  echo "android/ 已存在，跳过创建"
fi

echo "[4/5] 同步前端资源到 android/"
npx cap sync android

echo "[5/5] 允许 APK 访问局域网 HTTP 数据服务"
node scripts/patch-android.js

echo ""
echo "完成。下一步在 Android Studio 中打开 android/ 目录，或运行 ./scripts/build-apk.sh 生成 APK。"
echo "构建时可用 KYIV_DATA_URL=http://192.168.1.10:8787 预置数据服务地址，装完即用；"
echo "否则需在应用「设置」中手动填写。Node 服务必须与手机网络互通。"
