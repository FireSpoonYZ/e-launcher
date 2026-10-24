# Tauri Android 界面（`mobile/`，模块 18）

M18（Tauri Android 外壳）已交付并获父助手限定范围验收，总完成数 **18/20**；M19（Windows/Linux TUI）与 M20（跨设备集成、打包与真机验收）尚未开始。本目录只提供 Android 手机本机 Host 的可见界面，不替代本机 Host，也不含桌面客户端（见 [`desktop/`](../desktop/README.md)）。

## 组成：现有 APK 内的一块界面，不是第二个应用

- 沿用原 Gradle APK：`applicationId`/`namespace` 仍为 `com.example.launcherprobe`，原签名、原数据路径、原 Android 能力全部保留；没有生成第二个应用工程，也没有修改 vendored 的 Tauri Android SDK。
- `mobile/src-tauri/`：Rust crate `e-launcher-mobile`（`[lib] name = "e_launcher_mobile"`，`cdylib`），固定 `tauri = 2.12.5`、`tauri-build = 2.7.4`，启用 `custom-protocol` 让前端资源编进库。
- `mobile/web/`：Tauri 前端的唯一入口（`HashRouter` + 既有 `web/src/Host` 的 `HostPage`，`persistentPending`）；`mobile/web/src/mobile.css` 只补工具栏与滚动区，复用 `web/src/styles.css`。
- `vite.mobile.config.ts` 把 `mobile/web` 构建到 `mobile/build/web`（`tauri.conf.json` 的 `frontendDist` 是 `../build/web`）。
- `app/build.gradle` 的 `buildMobileUi` 任务产出 Rust cdylib、wry/tauri 生成的 Kotlin，以及作为 Gradle assets 源根 `app/build/generated/assets/tauri/` 内的 Rust 通知（APK 内 asset 路径为根目录下的 `THIRD_PARTY_NOTICES.txt`）。

## 为什么要独立进程

Tauri 的 Android 运行链路（App.run → tauri-runtime-wry.run → tao `EventLoop.run`）在 `run_return` 之后调用 `std::process::exit`。若界面与 Host 同进程，SDK 正常退出会连带杀掉默认 Java 进程——它负责 Host/FGS 并拉起独立的 Node Mobile 子进程。因此界面放在独立进程 `:tauri_ui`（manifest `exported=false`、`singleTask`、`windowSoftInputMode=adjustResize`），并在进程内首个 WebView 创建前设置 WebView 数据目录后缀 `tauri-ui`，与旧 Capacitor 进程的 WebView 目录/localStorage 隔离。默认进程的 `InitializationProvider`、WorkManager 与旧 provider 均未改动；`:tauri_ui` 另有一个 lifecycle-only 的 `TauriInitializationProvider`（`authority=${applicationId}.tauri-startup`、仅 `androidx.lifecycle.ProcessLifecycleInitializer`），用于让 wry 的 `ON_CREATE` 能通知 Rust 建界面，不启动 Host/Node/FGS。

## 入口与固定旧入口

- 普通 `ACTION_MAIN`+`CATEGORY_LAUNCHER`（无显式旧 extras）与 `assistant_open_host=true` 进入 Tauri 界面：`MainActivity` 先沿既有 Host-only 初始化建立有效 Bridge，再显式启动 `TauriMainActivity` 并 finish 自己。
- `assistant_legacy_ui=true` 抑制重定向，是真实的旧入口兼容开关；带旧 extras（新会话、归档、定时任务、设置、聊天详情、归档 id）的 Intent 仍按原路由走 Capacitor/旧 Activity。
- Tauri 工具栏只有 5 个固定控件：**隐藏**（仅把界面移到后台）、**旧会话**、**设置**、**旧 Host 待确认**、**重连**。`openLegacy` 只接受 `chat` / `settings` / `host` 三个枚举值，不存在任意 Intent、路径或 shell 转发。
- 旧 Host 的 pending、草稿与 localStorage 仍通过「旧 Host 待确认」进入原 Capacitor 页面访问，不复制、不迁移、不自动重放。

## 命令与桥

- JS 侧只有 4 个命令：`mobile_host_request`、`mobile_host_listen`、`mobile_host_ack`、`mobile_host_unlisten`；插件 id `android-host`，Kotlin 类 `BotHostTauriPlugin`，capability `main.json` 只给 `main` 窗口授予这 4 个权限；窗口使用 HTTPS 资源协议（`https://tauri.localhost`），CSP 只允许自身脚本与 `ipc:`/`https://ipc.localhost`。
- 桥是私有、非导出、同 UID 校验的 Binder 服务：Binder 事务只返回 socket FD，业务走 UTF-8 JSONL（`request`/`response`/`event`）。上限：2 MiB 行、8 个在途普通请求、8 帧/4 MiB 事件预算、暂停/清理保留通道、25 s 请求截止与 5 s 绑定截止、按 generation/nonce 的投递身份、单一原生事件代理与最多一个等待 ACK 的事件帧。
- 公开 Host 控制方法仍是 **35 个**；Kotlin 内的 `start`/`stop`/`openLegacy`/`reconnect`/`hide` 是 UI 本地动作（socket 内另有 `uiSettings`、`pause`），不是新增公开方法。`streamError` 是私有事件通道，不新增 JS 命令或 Host API。

## 数据、生命周期与凭据

- Host 运行数据仍在 `files/bot-host`，模型凭据在 `bot_host_credentials`，语音偏好/秘密在 `bot_host_voice`/`bot_host_voice_secrets`；界面 `uiSettings` 只含 language/appearance，不读 Pi 配置、没有凭据 getter。
- 关闭界面、关闭观察或 socket EOF 只释放**该 UI 会话**持有的观察与语音捕获，不调用 `stop`/`abort`/`resume`，不停止 Host；重连只重建本 UI 传输，不重发观察或变更类请求。
- pending：Tauri 界面在独立后缀的 localStorage 保存冻结的 requestId/文本/语音身份（写成功才发送）；旧 pending 仍用 sessionStorage，互不迁移；损坏或冲突记录阻止新发送。删除/替换（包括正常受理回执、已知未派发的语音失败、用户显式本地清除）都先核对持久存储里的原身份与不可变内容；未知结果保留原 ID，供只读对账或用户显式本地清除，不自动重放。取消语音的回执不能证明没有提交，因此不能仅凭它清掉语音身份。
- 接收 `queued/placed` 回执不等于完成：界面按 ≥1000ms、最多 1 个在途只读 `getSubmission` 刷新已接受回执，隐藏/断开/终态停止；显式重连恢复传输与只读刷新，但不重新观察、不自动发送。

## 权限与语音

麦克风权限由插件 `@TauriPlugin` 声明，Kotlin 侧在 `startVoice` 前检查真实前台与权限，权限回调按 generation 归属；语音沿用默认进程 Host 的既有“冻结 botId/requestId 只提交一次”语义与事件形状，重复/迟到回调不会串到新捕获。debug 构建开启 WebView 检查，release 保持关闭，未放松 CSP/Origin/TLS。

## 构建与先决条件（Windows PowerShell）

JDK 21、Android SDK Platform 36、NDK `28.2.13676358`、AGP 8.13.0 / Gradle 8.14.3、Kotlin 2.3.20、Node **≥ 22.19**，以及 Rust：SDK 引导的 `cargo metadata` 只需要 Cargo（不需要 Android target 或 NDK）；真正编译 `libe_launcher_mobile.so` 的 ABI 构建才需要相应 `rustup target add aarch64-linux-android x86_64-linux-android` 与 NDK。

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node host-core/build-mobile.js --sdk-path    # 可选：提前生成 SDK include 片段（settings 阶段缺失时也会自动生成）
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
.\gradlew.bat :app:assembleDebug --no-daemon --console=plain   # 默认 arm64-v8a
exit $LASTEXITCODE
```

按需选 ABI：把同一条命令换成 `-PlauncherAbis=x86_64`（模拟器）或 `-PlauncherAbis=arm64-v8a,x86_64`（一个 APK 同时含两种 ABI），不需要连续构建多次。`:app:assembleDebug` 依赖的 `buildMobileUi` 已包含界面前端构建；只改前端想看产物时单独跑 `npm run mobile:web`（tsc + vite → `mobile/build/web`）。

- SDK include 片段 `mobile/build/tauri-sdk.gradle` 是生成物且被忽略：`settings.gradle` 在它缺失时会在配置阶段用 `providers.exec`（`workingDir = rootDir`、显式 argv、不过 shell）同步执行 `node host-core/build-mobile.js --sdk-path`，成功生成后才 `apply`。这同时覆盖 plain Gradle、CI 与 `scripts/verify.ps1`，不需要改任何调用方。手动先跑 `node host-core/build-mobile.js --sdk-path` 仍然有用（可提前定位问题），但不是必需。
- 如果 helper 跑完后片段仍不存在（例如 Cargo 不可用或 `mobile/src-tauri` 的 Cargo 图解析失败），Gradle 会抛带退出码与修复指引的 `GradleException`。注意：`node`/`cargo` 本身无法启动时，`providers.exec` 会直接以 Gradle 的 Exec 失败报错，不会进入这个自定义分支；两者都是真实构建错误，不会猜 cargo registry 目录，也不做 lock 刷新回退。
- `:app:assembleDebug` 依赖 `buildMobileUi`，它执行 `node host-core/build-mobile.js --abis <launcherAbis> --ndk <sdk>/ndk/28.2.13676358`：构建 release 版 Rust cdylib、用 NDK clang 显式参数交叉编译并校验 16 KiB ELF 对齐、把 wry/tauri 生成的 Kotlin 写入 `app/build/generated/source/tauri`、把 `.so` 放到 `app/build/generated/jniLibs/tauri/<abi>`，并把按实际构建 ABI 的 cargo 图生成的完整 Rust 通知写到 Gradle assets 源根 `app/build/generated/assets/tauri/THIRD_PARTY_NOTICES.txt`（APK 内 asset 路径是 `THIRD_PARTY_NOTICES.txt`，不是 `tauri/` 子目录）。
- `gradle.properties` 固定 `org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8`（完整 APK + androidTest 构建实测需要）；未设 Gradle/Cargo 并行上限；Kotlin 数据用 KGP 默认 `.kotlin/`（已忽略）。
- 当 `:tauri-android` 工程（cargo registry）与工作树不在同一磁盘根时，仅该工程的 `KotlinCompile` 关闭增量编译；`:app` 保持增量。
- 依赖自带的法务文本（`/META-INF/LICENSE`、`/META-INF/LICENSE.txt`、`/META-INF/NOTICE`、`/META-INF/NOTICE.txt`、`/LICENSE`、`/LICENSE.txt`、`/NOTICE`、`/NOTICE.txt`）也是这 8 个路径：`android.packaging.resources` 只把这 8 项从 AGP 默认排除集合里移除，并按标准 DSL 加入 `resources.merges`（同名文件合并完整上游文本）。签名/MANIFEST 等其它默认排除、默认 service merge 与 `jniLibs.useLegacyPackaging` 均不变；不使用 `pickFirst`、不手工拼接替代文本。
- 法务资源已验证（限定范围）：删除生成片段后重新完整构建双 ABI `assembleDebug`+`assembleDebugAndroidTest` exit 0、片段自动重建且字节一致；新 APK 相对上一验收包只增加 `META-INF/LICENSE`、`META-INF/LICENSE.txt`、`META-INF/NOTICE` 三个条目，其余全部原条目（DEX/.so/所有 assets/res）按相同 ZIP 顺序单次解压 SHA256 完全一致；4 个 Jackson 2.15.3 依赖各自的 `META-INF/LICENSE`/`NOTICE` 共 8 项均包含在合并后的完整文本中；zipalign `-P16` 与原签名通过。此为父在本机做的限定验收，不等于远端 CI 已验证。
- Rust 依赖的完整通知仍由 `build-mobile.js` 汇总到 assets 的 `THIRD_PARTY_NOTICES.txt`，与上面的 Maven/jar 法务资源是两件事。
- 版本号、签名、`applicationId`、ABI 列表、16 KiB 页对齐与既有 Capacitor/Shower/Pi 资产管线均未改变。
- GitHub Actions `apk.yml` 在 Gradle 之前用 runner 自带 `rustup` 装 stable（minimal）与两个 Android target（不改本机工具链、不新增 action 依赖）；该步骤属于已实现的接线，**尚未在真实 GitHub runner 上执行**。本地构建只需本机已装 Rust，不需要这一步。

## 验证边界（父助手限定范围）

- 环境：保留 userdata 的专用 `emulator-5556`（Android 36 / x86_64）；`-no-audio` 静音模拟器 + 自有可信 HTTPS 合成 ASR。**无真机、无付费模型、无真实 Hindsight/ASR**；ARM64 只构建（ELF 对齐、zipalign `-P16`）未运行。
- 已实测：真实 Tauri React 资源/启动/桥；冷启动不拉起 Host/Node 且保留 deviceId 与初始 DB 哈希；Unicode/emoji 创建与聊天、文字与语音回执到 done；界面返回/SIGKILL 后已受理任务仍由同一 Host/Node 完成，冻结原 ID 在回执丢失与 UI 进程死亡后仍可对账且无重放；存储读/写失败阻止发送、owner 冲突、缺失重发与非法 modelRef、条件清理；8 个 RPC 准入与第 9 个 `RPC_BUSY`、已写出 25 s `TIMEOUT`/unconfirmed、超 2 MiB/未知方法/非法 legacy 动作拒绝；8 观察 + 最多一个等待 ACK 的事件帧、溢出锁存、显式重连恢复、旧/重复 ACK 无害；空闲 EOF 只发一条私有 `streamError` 并显示提示；首次授权/拒绝/权限期间 Home/显式取消后迟到授权不启动采集；竖/横屏工具栏、原生 systembar padding、键盘把视口从 684 压到 400 且输入可滚动；固定旧会话/设置/Host 路由与独立 WebView 存储隔离。
- 未实测：ARM64 运行时、真实模型/ASR/Hindsight、完整跨设备中继与目标切换（M20）、全部传输字节饱和与竞态、5 s 绑定故障定时器、全部外观组合。
- 法务资源改动之后没有重跑设备 E2E：上述设备验收适用于字节一致的原有 APK 条目（Stage 12 已逐条 SHA256 比对），新增的只有 `META-INF/LICENSE|NOTICE` 等法务条目与构建/CI 接线；远端 GitHub Actions 仍未实际运行。
- 旧回归的普通检查里 `notifications` 组仍在“立即删除是否清空通知”断言处失败 3 次（M16 起的既有问题；调试器暂停下通过但不属于普通通过，确切原因未确认），其余 10 组正常通过；不要据此宣称 11 组全部普通通过。
