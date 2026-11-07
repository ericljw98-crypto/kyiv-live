# 基辅安全信息汇总

面向个人的中文移动端看板，汇总基辅市的空袭警报状态、按分组的轮流停电计划，以及 Київводоканал 官方发布的停水公告。同一套前端既作为 PWA 在浏览器中使用，也由 Capacitor 打包为 Android APK。

本仓库托管于 GitHub 账号 `ericljw98-crypto`。版本真源是根目录 `version.json`（当前 1.1.0），编译产物见 `dist/kyiv-live-debug.apk` 与 `dist/SHA256SUMS.txt`，同时可作为 GitHub Release 资产分发。

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

## 自动检查更新

应用启动时（延迟约 1 秒）、从后台切回前台时、每 30 分钟，以及点击「立即刷新」或「设置 → 立即检查更新」时都会检查版本；自动触发统一受 5 分钟节流约束，不会随 20 秒的数据轮询重复请求。检查优先读取公开仓库的 `https://api.github.com/repos/ericljw98-crypto/kyiv-live/releases/latest`，取不到时回退到本机数据服务的 `/api/update`，该接口返回 `version.json` 中的版本、更新说明以及根目录 APK 的大小与 SHA-256。两条路径都不需要令牌。

APK 内的当前版本是编译期写入 `www/app.js` 的 `BUILD_VERSION`，不依赖服务端返回值，因此不会被新版本的服务端或 Service Worker 缓存反向覆盖。浏览器同源部署时以 `/api/update` 返回的版本作为当前版本，页面资源更新则由 Service Worker 单独提示「点击刷新」，不静默重载页面。

发现更高版本时，页面顶部出现蓝色提示条，显示新版本号、来源、更新说明与安装包大小，提供「下载更新」「稍后」「忽略此版本」三个操作；已授权浏览器通知时还会发一条与警报无关的版本提示。「忽略此版本」写入本地存储，之后不再自动弹出，但手动检查仍能看到结果。应用**只提示，不自动下载、不自动安装，也不替换 APK 内已打包的网页资源**：Android 侧载安装必须由用户确认，覆盖安装不会清除已保存的设置。

需要特别注意：v1.0.0 及更早的安装包内没有更新检查代码，必须先手动安装一次 1.1.0 或更高版本，之后才能收到自动更新提示。这条限制无法通过服务端改动绕过。

发布新版本时，修改 `version.json` 的 `version`、`versionCode`（每次递增）、`releasedAt` 与 `notes`，执行 `npm run version:sync` 把版本同步到 `www/version.json`、`www/app.js`、`package.json` 与 Gradle，再执行 `npm run build:apk` 构建并更新 `dist/` 校验和，最后提交并用 `npm run publish:github` 发布同名 tag 的 Release。客户端靠 Release 的 `tag_name` 判断版本，所以 tag 必须是 `v` 加三段式版本号，资产文件名须保持 `kyiv-live-debug.apk`。

## 版本号规范

工程采用严格三段式语义化版本 `vMAJOR.MINOR.PATCH`，例如 `v1.1.0`。三段都是十进制整数，不补前导零，不附加 `-rc`、`+build`、日期或渠道后缀。这不是风格偏好：客户端按三段十进制数字比较版本，`v1.2.0-rc.1` 会被当作 `1.2.0`，而 GitHub 的 `releases/latest` 不把 prerelease 视为最新，两者叠加会出现「提示了却下载不到对应包」的状态。

| 位 | 触发条件 | 示例 |
| --- | --- | --- |
| PATCH | 数据源解析容错、文案与排版、构建脚本、依赖安全修复，以及不改变既有设置与接口契约的缺陷修复 | 1.1.1 |
| MINOR | 新增功能模块、新增官方数据源、新增设置项或界面卡片，且旧设置仍可直接沿用 | 1.2.0 |
| MAJOR | 应用标识、包名或签名变更，数据服务接口不兼容，必须重新配置才能运行，或信息边界发生根本变化 | 2.0.0 |

内容边界不可逾越，应用标识与接口契约也保持稳定，因此 MAJOR 在可预见的范围内不会使用；这不意味着可以把不兼容变更塞进 MINOR。`versionCode` 是与版本字符串一一对应的纯递增发布序号，不把三段语义编码进数字：已发布的 1.0.0 对应 1、1.1.0 对应 2，无论下一次选 1.1.1 还是 1.2.0，versionCode 都是 3，再往后的 2.0.0 是 4。Android 只允许覆盖安装更高 versionCode 的包，所以序号不得回退或复用，也不允许同一版本对应多个序号。决定下一次版本号的规则是确定的：只修问题用 1.1.1，加新功能用 1.2.0，两者都取 versionCode 3。

tag 固定为 `v` 加 `version.json` 的 `version`，Release 资产名固定 `kyiv-live-debug.apk`；不创建 prerelease，不删除已发布 Release，否则 `releases/latest` 会回退到旧版本，客户端的判断随之失真。`notes` 写一句用户可感知的变化，8 至 120 字，会同时出现在更新提示条与 Release 说明里；`releasedAt` 用 `YYYY-MM-DD`。同一版本允许重新构建或重发资产，但客户端不会提示更新，要让用户收到提示必须提升版本号。

规则由 `scripts/version-rules.mjs` 统一定义，构建与发布两端共用。`npm run version:sync` 校验格式、日期与更新说明，并读取 `git show HEAD:version.json` 与上一版对照，拒绝版本回退、拒绝 versionCode 不递增、拒绝同版本改序号；`npm run publish:github` 发布前再校验一次，并核对 `dist/SHA256SUMS.txt` 与 APK 实际 SHA-256 一致，防止改了源码却忘记重新构建就发版。客户端的 `parseVersion` 为兼容历史 tag 采用前缀匹配，因此禁止绕过脚本手工创建带后缀的 Release。

## 本地运行

需要 Node 18 以上。

```
npm install
npm start
```

浏览器访问 `http://localhost:8787`；手机与电脑处于同一局域网时访问 `http://<电脑局域网IP>:8787`，用浏览器菜单「添加到主屏幕」即可像应用一样使用。

服务还提供手机友好的安装页 `http://<电脑局域网IP>:8787/install`。同一 Wi-Fi 下的手机打开该页即可直接下载项目根目录下的 `kyiv-live-debug.apk`，页面会注入当前局域网地址作为首次要填的数据服务地址，并显示文件大小与 SHA-256 校验值。下载走精确路径 `/kyiv-live-debug.apk`，支持 HEAD 与 Range 分段，元信息见 `/api/apk-info`；服务端只提供这一个安装包，不暴露项目目录，也不接受请求中的文件路径。手机能否访问取决于本机防火墙是否放行 8787 端口入站，以及电脑与手机是否处于同一网络。

本版本 APK 已预置当前局域网的数据服务地址，装完打开即可取数；更换 Wi-Fi 或电脑 IP 变化后，需在「设置 → 数据服务地址」改填新地址。`www/config.json` 中的 `proxyBase` 为空时不会发起请求；构建时可通过 `KYIV_DATA_URL` 预置该地址。

alerts.in.ua 官方令牌的申请入口为 `https://alerts.in.ua/api-request`。取得令牌后把 `.env.example` 复制为 `.env`，填入 `ALERTS_UA_TOKEN`，重启服务，执行 `npm run check:token` 验证。令牌只保留在服务端环境变量中，不写入前端、仓库或 APK。

## 数据服务的托管边界

数据服务源码 `server/` 与全部依赖配置已随每次提交推送到公开仓库 `ericljw98-crypto/kyiv-live`，「把代码放进 GitHub」这件事已经完成。但 GitHub 不能运行这个长驻 Node 进程：GitHub Pages 只发布仓库中的静态 HTML、CSS、JavaScript，不执行服务端代码；GitHub Actions 是短时任务，官方文档规定定时工作流最短间隔 5 分钟，且高负载时可能延迟或丢弃；Codespaces 是开发容器，会休眠并有额度限制，不能承担 24 小时可用的数据接口。仓库能提供的是源码、APK 与更新检查所依赖的 Release 接口，不是数据接口本身。

结论是不把实时数据服务迁到 GitHub。警报模块目前在服务端缓存 20 秒、界面最快 20 秒刷新，这个粒度是功能成立的前提；若改用 Actions 定时抓取后写入仓库的静态 JSON，警报状态至少滞后 5 分钟，任务延迟时更久，把这样的快照标注为实时警报属于误导。供水公告与停电计划可以容忍分钟级延迟，但同一份数据同时承载警报状态时，不能按最低共同标准降级。

若目标是让手机脱离这台电脑仍能看到数据，正确路径是把 `server/sources.js` 的聚合逻辑部署到支持长驻 HTTP 或按请求触发的云服务（云主机、Node 托管平台，或边缘函数），再把「设置 → 数据服务地址」改为公网 HTTPS 地址。服务端已支持 `HOST`、`PORT`、CORS 与可选的 `ALERTS_UA_TOKEN`，迁移不需要改 APK，也不影响自动更新：更新检查走 GitHub Release，与数据服务地址相互独立。这条路径需要一个云平台账号，且从境外节点访问 YASNO、Київводоканал、Tryvoha 的可用性必须实测；若上游限制数据中心 IP，还需在代理层处理。仓库不保存任何云平台凭据。

## 构建 APK

需要 JDK 17 以上与 Android SDK（compileSdk 36），并设置 `JAVA_HOME`、`ANDROID_HOME`。

```
npm run setup:android   # 首次生成 android/ 工程
npm run version:sync    # 改动 version.json 后同步版本（build:apk 内也会自动执行）
npm run build:apk       # 生成 kyiv-live-debug.apk 并刷新 dist/ 校验和
```

Windows 下也可直接运行 `scripts\build-apk.bat`。产物为 debug 签名，包名 `app.kyivlive.board`，minSdk 24、targetSdk 36。安装命令：`adb install -r kyiv-live-debug.apk`。

## 发布到 GitHub

发布脚本为 `scripts/publish-github.mjs`，零第三方依赖。它读取环境变量 `GITHUB_TOKEN`，校验令牌所属账号，创建或复用 `ericljw98-crypto/kyiv-live` 仓库，推送当前提交，按 `version.json` 的版本号创建 `v<版本>` Release 并上传 APK 资产，Release 说明会自动带上 `notes`。客户端的更新检查正是读取这个 Release，因此发布成功后手机上才会出现更新提示。令牌不会写入仓库、日志或任何配置文件。

```
GITHUB_TOKEN=<personal access token> npm run publish:github
```

所需令牌推荐 classic PAT（`ghp_` 开头，勾选 `repo`）。若使用 fine-grained token（`github_pat_` 开头），除 `Contents: Read and write` 外，还必须在 Account permissions 中把 `Repository creation` 设为 Read and write，否则 `POST /user/repos` 会返回 403；也可以在 `https://github.com/new` 手动创建名为 `kyiv-live` 的空仓库（不要初始化 README），脚本会自动复用并继续推送与发布。

脚本默认创建**私有仓库**，加 `--public` 参数可创建公开仓库或把已有私有仓库改为公开。`github.com/ericljw98-crypto/kyiv-live` 当前为**公开仓库**，Release 的 APK 可免登录直接下载，手机浏览器打开下载链接即可安装；更新检查接口对公开仓库同样免令牌。脚本只会把私有改为公开，不会反向改回；如需恢复私有，在仓库 `Settings → General → Danger Zone → Change visibility` 操作，或用 API `PATCH /repos/ericljw98-crypto/kyiv-live` 提交 `{"private": true}`。

公开会带来一项不可逆的影响：源码与 git 历史中包含默认关注地址（вул. Добровольчих батальйонів 44а、Печерський район），涉及 `server/sources.js`、`www/app.js`、`www/index.html`。仓库转为公开后，这些信息可被搜索引擎与爬虫抓取，即使随后改回私有也无法撤回已产生的副本。若需脱敏，应把默认地址改为运行时填写、清理历史提交并重新构建 APK，而不是仅删除当前版本的文件。

## 目录

```
version.json  版本真源，由 npm run version:sync 同步到各编译产物
server/    零依赖 Node 代理与数据聚合、缓存、区域筛选、/api/update 更新接口
www/       PWA 前端、图标、manifest、service worker、版本描述
scripts/   图标生成、Android 补丁、构建与发布脚本
android/   Capacitor 生成的 Android 工程
dist/      已编译 APK 与 SHA-256 校验和
```
