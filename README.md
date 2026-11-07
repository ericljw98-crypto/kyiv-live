# 基辅民生与民防信息看板

面向个人的中文移动端看板，汇总基辅市的空袭警报状态、按分组的轮流停电计划，以及 Київводоканал 官方发布的停水公告。同一套前端既作为 PWA 在浏览器中使用，也由 Capacitor 打包为 Android APK。

本仓库托管于 GitHub 账号 `ericljw98-crypto`。当前版本为 1.0.0，编译产物见 `dist/kyiv-live-debug.apk` 与 `dist/SHA256SUMS.txt`，同时可作为 GitHub Release 资产分发。

## 数据边界

空袭警报仅显示官方预警发布的区域级状态、红/黄级别与威胁类型标签（例如「无人机威胁」「导弹威胁」）。不接入来袭目标坐标、飞行轨迹、速度、拦截动态、防空系统位置与作战实况。依据是乌克兰刑法第 114-2 条及乌克兰安全局、基辅市政府的相关规定：此类实时信息可被用于校正后续打击。应用内的说明为常驻内容，不是可关闭的选项。

本应用不是官方预警系统。避险决策以实体警报器、官方 Air Alert 应用与地方政府通报为准。

## 数据源

| 模块 | 来源 | 说明 |
| --- | --- | --- |
| 空袭警报 | Tryvoha 公开警报聚合接口（免密钥） | 区域级状态与威胁类型；配置 `ALERTS_UA_TOKEN` 后自动切换至 alerts.in.ua 官方接口 |
| 停电 | YASNO / DTEK 公开接口（region 25 / dso 902） | 按分组的停电时段、紧急停电状态、按地址查询分组 |
| 供水 | Київводоканал 官网 `/news`、`/shutoffs` | 公告与按地址列出的事故、计划停水；按关注区域筛选 |

停水没有结构化的实时管网状态接口。官网在战时出于安全考虑不公开逐栋停水明细，具体门牌需拨打官方调度电话确认。区域筛选基于公告中的街道、片区与区名关键词，可能漏判，界面已标注该限制。所有数据源失败时显示「暂不可用」或缓存标记，不以推测状态冒充实时状态。

## 警报实时性与提醒

警报状态在服务端缓存 20 秒，多个客户端共享一次上游请求，避免抬高免密钥公开源的调用频率。界面默认每 60 秒刷新，可在「设置 → 自动刷新间隔」调至最快 20 秒，调得更快只会重复读到同一份缓存；页面切到后台时自动暂停。浏览器通知只在警报生效或解除、且应用处于打开状态时提示，属于补充提醒，不替代官方预警。

可靠的即时推送应以官方「Повітряна тривога / Air Alert」应用、城市警报器与地方政府通报为准。本应用不接入 Telegram 等平台上实时分享来袭方向、坐标、航迹、爆炸地点、拦截动态或防空系统位置的频道：这类内容属于实时军事情报，依据乌克兰刑法第 114-2 条及乌克兰安全局、基辅市政府规定不得传播，且可被用于校正后续打击。合规的区域级警报状态与威胁类型标签已由 Tryvoha / alerts.in.ua 覆盖，抓取此类频道没有信息增量。该边界不是可开关选项。

## 本地运行

需要 Node 18 以上。

```
npm install
npm start
```

浏览器访问 `http://localhost:8787`；手机与电脑处于同一局域网时访问 `http://<电脑局域网IP>:8787`，用浏览器菜单「添加到主屏幕」即可像应用一样使用。

服务还提供手机友好的安装页 `http://<电脑局域网IP>:8787/install`。同一 Wi-Fi 下的手机打开该页即可直接下载项目根目录下的 `kyiv-live-debug.apk`，页面会注入当前局域网地址作为首次要填的数据服务地址，并显示文件大小与 SHA-256 校验值。下载走精确路径 `/kyiv-live-debug.apk`，支持 HEAD 与 Range 分段，元信息见 `/api/apk-info`；服务端只提供这一个安装包，不暴露项目目录，也不接受请求中的文件路径。手机能否访问取决于本机防火墙是否放行 8787 端口入站，以及电脑与手机是否处于同一网络。

首次在 APK 中打开时，需在「设置 → 数据服务地址」填入手机可访问的 Node 服务地址。`www/config.json` 中的 `proxyBase` 为空时不会发起请求；构建时可通过 `KYIV_DATA_URL` 预置该地址。

alerts.in.ua 官方令牌的申请入口为 `https://alerts.in.ua/api-request`。取得令牌后把 `.env.example` 复制为 `.env`，填入 `ALERTS_UA_TOKEN`，重启服务，执行 `npm run check:token` 验证。令牌只保留在服务端环境变量中，不写入前端、仓库或 APK。

## 构建 APK

需要 JDK 17 以上与 Android SDK（compileSdk 36），并设置 `JAVA_HOME`、`ANDROID_HOME`。

```
npm run setup:android   # 首次生成 android/ 工程
npm run build:apk       # 生成 kyiv-live-debug.apk
```

Windows 下也可直接运行 `scripts\build-apk.bat`。产物为 debug 签名，包名 `app.kyivlive.board`，minSdk 24、targetSdk 36。安装命令：`adb install -r kyiv-live-debug.apk`。

## 发布到 GitHub

发布脚本为 `scripts/publish-github.mjs`，零第三方依赖。它读取环境变量 `GITHUB_TOKEN`，校验令牌所属账号，创建或复用 `ericljw98-crypto/kyiv-live` 仓库，推送当前提交，创建 `v1.0.0` Release 并上传 APK 资产。令牌不会写入仓库、日志或任何配置文件。

```
GITHUB_TOKEN=<personal access token> npm run publish:github
```

所需令牌推荐 classic PAT（`ghp_` 开头，勾选 `repo`）。若使用 fine-grained token（`github_pat_` 开头），除 `Contents: Read and write` 外，还必须在 Account permissions 中把 `Repository creation` 设为 Read and write，否则 `POST /user/repos` 会返回 403；也可以在 `https://github.com/new` 手动创建名为 `kyiv-live` 的空仓库（不要初始化 README），脚本会自动复用并继续推送与发布。

脚本默认创建**私有仓库**，加 `--public` 参数可创建公开仓库或把已有私有仓库改为公开。`github.com/ericljw98-crypto/kyiv-live` 当前为**公开仓库**，Release `v1.0.0` 的 APK 可免登录直接下载，手机浏览器打开下载链接即可安装。脚本只会把私有改为公开，不会反向改回；如需恢复私有，在仓库 `Settings → General → Danger Zone → Change visibility` 操作，或用 API `PATCH /repos/ericljw98-crypto/kyiv-live` 提交 `{"private": true}`。

公开会带来一项不可逆的影响：源码与 git 历史中包含默认关注地址（вул. Добровольчих батальйонів 44а、Печерський район），涉及 `server/sources.js`、`www/app.js`、`www/index.html`。仓库转为公开后，这些信息可被搜索引擎与爬虫抓取，即使随后改回私有也无法撤回已产生的副本。若需脱敏，应把默认地址改为运行时填写、清理历史提交并重新构建 APK，而不是仅删除当前版本的文件。

## 目录

```
server/    零依赖 Node 代理与数据聚合、缓存、区域筛选
www/       PWA 前端、图标、manifest、service worker
scripts/   图标生成、Android 补丁、构建与发布脚本
android/   Capacitor 生成的 Android 工程
dist/      已编译 APK 与 SHA-256 校验和
```
