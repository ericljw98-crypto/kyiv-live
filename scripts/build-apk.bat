@echo off
rem Windows 版一键构建。需要 JDK 17+、Android SDK、已运行过 npm run setup:android。
setlocal
cd /d "%~dp0.."

where java >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 java，请安装 JDK 17+ 并加入 PATH。
  exit /b 1
)
if "%ANDROID_HOME%"=="" if "%ANDROID_SDK_ROOT%"=="" (
  echo [错误] 请设置环境变量 ANDROID_HOME 指向 Android SDK 目录。
  exit /b 1
)
if not exist android\ (
  echo [错误] 缺少 android 工程，请先运行 npm run setup:android
  exit /b 1
)

echo [1/4] 同步版本、词库、图标、默认地址并同步资源
call node scripts\write-version.mjs
if errorlevel 1 exit /b 1
call node scripts\sync-zh.js
if errorlevel 1 exit /b 1
call node scripts\sync-aftermath.mjs
if errorlevel 1 exit /b 1
call node scripts\make-icons.js
if errorlevel 1 exit /b 1
call node scripts\set-default-proxy.js
if errorlevel 1 exit /b 1
call npx cap sync android
if errorlevel 1 exit /b 1
call node scripts\patch-android.js
if errorlevel 1 exit /b 1

echo [2/4] Gradle 构建 debug APK
cd android
call gradlew.bat assembleDebug --no-daemon
if errorlevel 1 exit /b 1

echo [3/4] 复制产物并生成分发校验和
copy /Y app\build\outputs\apk\debug\app-debug.apk ..\kyiv-live-debug.apk >nul
cd ..
call node scripts\dist-manifest.mjs
if errorlevel 1 exit /b 1

echo [4/4] 完成
echo APK 已生成： %cd%\kyiv-live-debug.apk
echo 安装到手机： adb install -r kyiv-live-debug.apk
endlocal
