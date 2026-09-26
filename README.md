# e-launcher 独立 AI 助手

普通 Android AI 助手应用，安装后显示为 **AI Assistant**，保留 Pi SDK 聊天、后台与定时任务、通知、分享导入、语音会话、系统语音助手、唤醒和朗读，以及 Shower 虚拟屏与接管。可把标准 Android App Widget 添加到其他桌面，不再充当默认 HOME，不提供桌面布局、应用网格／全局桌面搜索、壁纸／图标包管理、小组件宿主、模拟导航手势或自定义应用切换页。

## 界面与数据

`MainActivity` 是普通 Capacitor `BridgeActivity`，承载 `web/src/` 中的 React + TypeScript 聊天与设置。任务详情、语音会话和分享确认使用 Android Java Activity；Widget 使用 Java `AppWidgetProvider` + `RemoteViews`/XML，没有新增 UI 框架或数据库。应用目录查询与显式启动仍服务于助手和 Shower，不是桌面功能。`LauncherVoiceInteractionService` 等三个原系统语音组件名有意保留，以保持系统助手身份。

覆盖安装保留 `applicationId=com.example.launcherprobe`、包名、原签名及数据路径：聊天仍在私有 `chat` SharedPreferences，附件在 `files/chat-attachments`，Pi 上下文在 `files/pi-contexts`，全局配置在 `files/node/.pi/agent`，会话工作区在 `files/pi-workspaces`。旧未发送草稿及附件保留；不要清除数据、卸载重装或换签名来完成迁移。

## Pi Agent 与设置

Pi 模式接入固定版本 **0.85.1** 的完整 coding-agent SDK，提供模型、思考强度、原生工具与扩展、压缩重试、资源及包管理和 OAuth。当前聊天的模型选择与启动默认值分开保存。聊天输入栏的历史分支和思考强度按钮仅在键盘显示时出现；调整思考强度后浮窗保持打开，点击窗外返回输入栏。

独立设置页保留通用、外观、服务商、技能、MCP、扩展、关于七类，其余配置放入高级配置，覆盖文档中的 65 个 settings 字段。全局／工作区表单与 JSON 编辑器共用私有文件；支持自动格式化、未知字段和数字写法保留、草稿、冲突检查及上一版。开放式模型与兼容性结构可直接编辑完整 models.json。

界面支持跟随系统／中英文、浅色／深色、助手背景图片预览和遮罩。扩展页可直接输入 npm 包名安装，扩展社区使用 npm 公开元数据并提供搜索和分页；配置状态、SDK 找到的安装路径与成功加载分别说明。APK 内置与 Node 24 兼容的官方 npm 11.6.2，无需 Termux 或系统 npm；Git 来源仍需要对应系统命令。安装第三方包可能执行 lifecycle 脚本和代码，请仅使用可信来源。安装成功后会重新读取资源并报告加载、停用／过滤或错误状态，当前聊天下一次发送时使用新扩展。

内置 `conversation-title` 扩展在每轮正常回复完成后生成概括性短标题，对话选择页与任务 Widget 共用该标题。在「高级配置 → 模型与思考 → 标题生成模型」填写 `provider/modelId`，也可编辑全局 `~/.pi/agent/settings.json` 或工作区 `.pi/settings.json`：

```json
{
  "conversationTitle": {
    "model": "openai/gpt-4o-mini"
  }
}
```

请填写 Pi 模型目录中实际可用的服务商和模型 ID；模型沿用 Pi 的 `models.json`、API key 或 OAuth 配置，与聊天模型单独选择。工作区设置覆盖全局设置，下次发送生效。未配置或填空字符串时停用自动标题；生成失败、超时或取消时保留原标题。生成请求仅包含原始目标和最近几条对话文本，最多等待 15 秒，不作为聊天消息保存。标题写入原生 `session_info`，随会话上下文持久保存。

运行时集成和依赖准备见 [运行时与构建说明](pi-runtime/README.md)。

## Android 平台能力

Pi Agent 是聊天的唯一执行路径。内置 `shower` 工具使用 Operit Shower：按需通过现有 Shizuku 授权启动应用自有的 Binder-only 服务，为每个聊天分别创建一块虚拟屏，并在该屏启动 App、截图、点击、滑动、输入中文等 Unicode 文字、复制粘贴、发送受限按键和释放屏幕。宿主根据已登记的请求绑定聊天归属，不接受模型传入的聊天或屏幕 ID；服务端只接受本应用 UID 对非零虚拟屏的操作。不会退回或转发到手机主屏。历史会话中的旧工具调用与结果保留用于显示；继续对话时会作为不重新执行的历史上下文交给 Pi。

`shower` 必须先 `create`，服务未运行时会自动启动，同一聊天可复用已有屏幕。每块屏幕独立计算空闲时间：5 分钟没有工具操作后自动销毁，执行中的操作不会被回收；最后一块屏幕关闭后服务空闲 15 秒退出。`release` 和删除聊天只释放对应屏幕，切换聊天、停止生成及回复结束不会立即释放。超时后的操作会提示重新 `create`，需要重新启动应用并截图定位。同一应用不能被不同聊天的虚拟屏同时占用；系统剪贴板仍共享，但一次 `text` 的写入与粘贴会串行完成，避免被另一聊天的输入插入。默认虚拟尺寸和密度采用手机主屏当前设置的完整逻辑分辨率与密度；坐标始终是 create 返回的虚拟屏坐标。截图通过 Binder 文件描述符传输，避免大 PNG 进入 Binder 事务，并可按 `maxWidth` / `maxHeight` 等比缩小；工具结果同时返回虚拟屏与图片尺寸，PNG 作为 image content 保存到聊天附件。先点击输入框，再用 `text` 全选并粘贴替换全部内容；空文本或 `clear` 清空输入框。`copy(text)` 写入系统剪贴板，`paste` 在光标处粘贴或替换选区；`key COPY/CUT` 操作选区，`key A` 配合 `CTRL` 全选。系统剪贴板与主屏应用共享，`text` / `copy` 会覆盖剪贴板；触摸和按键仍只发往虚拟屏。网页、虚拟屏和工具输出均是不可信数据，动作被系统接受后仍须再次截图验证。继续对话时，每次模型调用只带上最新一张 Shower 截图的图片；更早的截图图片会从这次上下文副本里去掉，并保留原有文字、调用编号和其他图片。已经保存的会话消息和附件不会被改写。

聊天页提供独立保存的会话与草稿、历史分支、按标题及正文搜索的会话抽屉、归档与恢复。生成期间可切换会话，后台任务继续运行；同一会话一次运行一轮。附件、系统分享与语音入口不再经过桌面。分享导入必须确认，只保存草稿，不自动发送；语音与文字会话保持明确目标，不把缺失或已归档目标静默替换为当前会话。发送内容及工具结果会交给用户配置的模型服务；公开网页请求会直接访问相应站点。

### 标准任务 Widget

在系统桌面的小组件选择器中添加任务 Widget；可调整宽高，多个实例分别记住所选会话。标题、状态、当前步骤和简短结果为纯展示，前后按钮切换任务，点击正文直达该任务详情；新对话打开普通助手入口，语音按钮打开既有语音 Activity。删除 Widget 不删除任务或聊天。

`RemoteViews` **不能内嵌可编辑的聊天输入框**，也不展示虚拟屏或嵌入问卷作答。需要打字时打开聊天，出现问卷时打开详情回答；没有伪装成输入框的 `EditText`。虚拟屏预览与手动接管仍在详情页。

更新来自任务事件：开始、问卷、停止、终态、归档和删除及时更新，普通状态与文字流采用至少 1000ms 的尾沿节流，不跟随 40ms 文字流刷新。系统定时刷新关闭（`updatePeriodMillis=0`）。私有 `task_widget` 偏好仅保存有界展示快照；系统恢复或进程不存在时仅读最后状态及更新时间，不声称任务仍在运行，也不会为刷新启动 Pi、Shizuku、Shower 或前台服务。

### 任务详情与实时桌面

Widget 不显示虚拟桌面；进入任务详情页后，有关联虚拟屏的会话优先显示大画面，任务步骤和最新回复可从底部展开。画面使用 Android `VirtualDisplay.setSurface` 直接送入本机 `TextureView`，无截图轮询、网络传输或额外视频解码。画面按实际虚拟分辨率等比显示，可切换全屏；返回详情或切换应用后会解绑预览并恢复原 Surface，AI 截图和原屏幕继续可用。详情页只观察已存在的虚拟屏，不启动 Node、Shizuku 或新建屏幕。

点击「接管操作」后可直接点击、长按、拖动、滑动和多指操作。该会话后续的 `shower` 工具调用等待接管结束；已等待的非截图操作不会直接重放，而是提示 AI 先截图重新定位。结束接管、离开详情或画面释放都会解除等待。导航栏提供虚拟屏返回、应用列表、最近打开的应用和文字输入；最近应用来自本虚拟屏成功启动记录，不是手机系统任务列表。应用列表替代全局 HOME/RECENTS，避免某些 ROM 将按键送往主屏。文字输入可替换当前焦点输入框（最多 1000 字符），并提供退格、回车。页面给手机系统侧边和底部手势留出空间。

模拟器／设备检查需已运行并授权 Shizuku，安装 `:app:assembleDebug` 和 `:app:assembleDebugAndroidTest` 的 APK 后执行：

```powershell
& $adb shell am instrument -w -e checks shower-preview -e artifactDir /sdcard/Android/data/com.example.launcherprobe/files/acceptance com.example.launcherprobe.test/com.example.launcherprobe.ChatStoreChecks
```

此检查使用临时会话和系统设置应用，不调用模型；验证连续画面、触摸后画面变化、预览期间 AI 截图及退出后继续操作。测试会删除临时会话，截图写到显式 `artifactDir` 参数目录中的 `shower-preview-check.png`；拉取到电脑时必须使用仓库外目录。历史设备结果不能代表此次迁移通过，刷新率、键盘与 ROM 差异仍需设备验收。

### 定时任务

聊天页左侧会话抽屉的「新会话」下方提供「定时任务」入口。管理页支持创建、编辑、启用／暂停、删除及执行记录；周期设置与主表单共用一个底部面板，返回时保留主表单，关闭未保存的修改时会确认。助手内置 `schedule_task`，可 list、create、update 和 delete。update 只提交要改的字段，宿主按当前 revision 合并未提供的规则并保留启用或暂停；revision 不一致或任务已删除会返回错误，不会自动再提交一次。返回里的 `exactAlarmGranted` 为 false 或 `schedulingError` 非空只表示任务已保存，精确闹钟尚未排上，不能当成到点一定会执行。

- **每天**：指定时、分。
- **每周**：指定周一至周日中的一天及时间。
- **每月**：指定 1–31 日及时间；当月没有该日期时跳过当月。例如每月 31 日在 4 月不执行，下一次为 5 月 31 日。

工作日和非工作日暂未加入。时间跟随设备时区，界面通过原生规则预览下次执行；修改系统时间或时区后重新安排。夏令时不存在的本地时间由 `java.time` 向后调整，重复的本地时间只选择第一次。

任务使用 Android `AlarmManager` 精确闹钟调度，定义和执行记录保存于应用私有存储。Android 12 及以上需要用户在「闹钟与提醒」中授权；未授权时可保存任务，但页面会明确显示等待授权。恢复授权、重启设备或更新应用后重新安排未来任务，不从开机广播直接启动 Agent，也不补跑恢复时已过期的任务。系统迟到的闹钟最多执行一次，不重放此前的多次周期；上一次同名定时定义仍在执行时跳过本次并记录原因。

每次执行创建独立会话，使用全局默认模型，不改变当前聊天或未发送草稿。执行结果可在「执行记录」中打开对应会话；保留最近 100 条记录，尚在运行的记录不提前移除。暂停和删除只影响未来调度，不停止已经开始的执行，也不删除会话或历史。执行失败不自动重试外部操作；用户强行停止应用、撤销权限及系统后台限制仍可能阻止或中断执行，恢复时会显示中断或跳过记录。

浏览器界面检查：`node scripts/check-schedules.mjs`，使用 Chrome／Edge 和内存原生桥接样例验证真实 React 页面，截图保存到系统临时目录；`--serve` 可打开本地设计对照页面。此检查不会创建 Android 闹钟或调用模型，不能替代真机后台执行验证。原生周期和持久化回归见 `ScheduleRuleTest` 与 `ScheduledTasksTest`。

## 构建与检查（Windows PowerShell）

JDK 21、Gradle 8.14.3（仓库内 `gradlew`）、SDK Platform 36、AGP 8.13.0，minSdk29、targetSdk36。运行时网络使用 OkHttp 3.14.9。首次构建需下载 Gradle 发行包与构建依赖并接受 SDK 许可。先运行 `scripts/prepare-pi-runtime.ps1` 准备 Node Mobile、SDK 资源和锁定完整性的官方 npm 11.6.2 payload；JavaScript 改动后运行 `npm --prefix pi-runtime test` 重建并测试 bundle。Gradle 从 `shower-server/` 的固定来源构建精简 Binder-only APK，并以 `shower-server.jar` 生成到 App assets；不需要 Python、Lamda payload 或外部部署脚本。构建还会把真实 arm64 Node executable 以 `libnode_launcher.so` 打入 APK 的 native library 目录；npm 的完整目录保存在版本化 asset 中并仅在版本首次使用时原子展开。

首次构建或修改前端后，先安装依赖、构建并同步 Web 资源：

```powershell
npm ci
npm run build
npm run sync:android
```

Windows PowerShell 下使用仓库内的 Gradle Wrapper 编译：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"
.\gradlew.bat build --no-daemon --console=plain
exit $LASTEXITCODE
```

需要完整检查时再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

脚本要求 `JAVA_HOME` 指向 JDK 21，`ANDROID_HOME` 未设置时使用 `$env:LOCALAPPDATA\Android\Sdk`。`scripts/verify.ps1` 运行纯 Java `AgentChecks`、`ConversationTreeChecks`，Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug :shower-server:lintDebug`，APK 的 Pi/SDK/npm 资源检查，Shower 单 dex／必需类检查，以及旧实现残留、Widget 注册/XML 和空白/行尾检查。`-JavaOnly` 可只运行纯 Java 断言；`-StaticOnly` 可只检查源码、注册和格式，不启动 Gradle。

纯 Java 检查保留 Agent 循环、取消、恢复、历史、搜索及 URL 边界，不再编译已删除的手势/Pager/旧无障碍工具。Robolectric 覆盖持久化、普通入口、导航恢复、Widget 与通知等原生逻辑。APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。构建不证明 Widget 在任意桌面上的呈现、后台时限、语音或虚拟屏行为。

迁移后的 instrumentation 编译：

```powershell
.\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --console=plain
exit $LASTEXITCODE
```

安装应用及测试 APK 后，由验收者选择 `checks=store`、`migration`、`widget`、`questionnaire`、`notifications`、`share-intake`、`share-ui`、`voice-continuity`、`search-consistency`、`shower-preview`、`workbench` 或 `npm`。不传 `checks` 时运行持久化、普通 Capacitor 入口及无 Activity 的协调器文字流检查。`search-consistency` 是聊天／归档历史搜索，不是桌面搜索。Widget 检查只用 instrumentation 临时 `AppWidgetHost` 和短暂 `BIND_APPWIDGET` shell identity，结束时删除自有测试实例，不改变用户已有 Widget；验证真实 RemoteViews、两实例选择、详情／新对话点击和语音 PendingIntent 身份，不启动语音识别或注入系统桌面触摸。新建 provider 对象读取快照不是实际进程死亡，系统桌面添加／点击与真实进程重建由验收者另行记录。

`store` 检查使用目标应用缓存下的独立目录与专用偏好命名空间，不触碰真实聊天；instrumentation 与测试 APK 的 UID 不同，不能直接使用测试 APK 的私有目录。`migration` 检查需要预先授予 `WRITE_SECURE_SETTINGS`，验证实际系统设置在无标记、有标记和恢复完成后的行为，并在结束时恢复原导航值与标记。

产生截图的检查必须传 `-e artifactDir <设备绝对可写目录>`；`workbench` 的 ready/stop/answer 文件也在此目录。示例设备目录为 `/sdcard/Android/data/com.example.launcherprobe/files/acceptance`。截图、日志及拉取后的证据均在仓库外；测试生成物只放已忽略的 `build/`。详情／通知检查需预先授予通知权限，避免首次授权弹窗遮挡；语音连续性检查需录音权限。Shower 检查需 Shizuku 已运行并授权。独立构建、ADB 注入与真实手指体验不是同一层验收；本迁移文档不宣称设备检查已通过。

日常开发在 `develop`。每次 push 会构建 debug APK，在对应 GitHub Actions run 的 Artifacts 里下载，保留 7 天。合并或推到 `main` 时额外构建 release APK，并覆盖 GitHub Release [`latest`](https://github.com/FireSpoonYZ/e-launcher/releases/tag/latest)。CI 需要仓库 secret `DEBUG_KEYSTORE_BASE64`（项目根目录 `debug.keystore` 的 base64）。

纯 Java 检查的编译产物位于 `build/test-classes/`。思考强度浮窗的真机触摸回归脚本为 `scripts/check-thinking-slider.mjs`，设备连接和运行方式见文件开头的说明。

### 跨电脑使用同一开发签名

Debug 构建固定使用项目根目录的 `debug.keystore`，不再使用各电脑自动生成的 `~/.android/debug.keystore`。该文件已加入 `.gitignore`，需要通过私密渠道将**同一份文件**复制到其他电脑的项目根目录；缺失时 Gradle 会报错，不会自动生成替代密钥。首次配置沿用本机已有开发密钥，因此签名与本机此前构建的 APK 一致。

这是标准 Android debug 密钥，别名为 `androiddebugkey`，存储和密钥密码均为公开默认值 `android`，仅用于开发，不用于正式发布。本地 debug 构建和 CI 的 debug/release APK 都用这一份密钥，因此可以互相覆盖安装。不要在另一台电脑重新生成密钥或随意替换此文件，否则旧签名的应用无法覆盖更新。当前开发证书 SHA-256：

```text
6f6ff43d800aa2eb8444a78d4f3992a0157f5bae2ca0a31a97da753187d01ffb
```

## 安装与迁移救援

使用原开发签名覆盖安装，然后像普通 App 一样打开。不请求 HOME，不修改任何无障碍服务列表，也不会重新启用旧导航手势。需要系统语音助手时由用户在设置中显式选择；Shower 保留既有 Shizuku 授权链路，仅在工具需要时创建虚拟屏。

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$serial = '<已授权设备序列号>'
& $adb -s $serial install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb -s $serial shell am start -n com.example.launcherprobe/.MainActivity
```

旧版可能留下 `gestures.pending_restore=true`。只有存在该标记时，`LegacyNavigationRecovery` 才在 Activity 恢复时尝试把 `Settings.Global.force_fsg_nav_bar` 写为 `0` 并读回；这是旧版停用手势的三键恢复契约，不是猜测用户此前的任意导航值。只有读回成功且清除标记提交成功才完成，失败保留恢复责任以供重试。没有标记绝不写导航设置，也绝不写 `1`。`WRITE_SECURE_SETTINGS` 保留用于这次迁移与用户显式救援。

权限不足时设置页显示恢复状态、可复制 ADB 命令、系统设置入口及显式 Shizuku 重试。`WRITE_SECURE_SETTINGS` 不是普通运行时权限；ROM 是否接受必须以实际结果为准。恢复不启用／重绑无障碍，不申请默认桌面。若旧版曾设为 HOME，请在系统默认应用设置中选择系统桌面，不要禁用或卸载系统桌面。

```powershell
& $adb -s $serial shell pm grant com.example.launcherprobe android.permission.WRITE_SECURE_SETTINGS
& $adb -s $serial shell settings put global force_fsg_nav_bar 0
& $adb -s $serial shell settings get global force_fsg_nav_bar
& $adb -s $serial shell am start -a android.settings.SETTINGS
```

ADB 写入为用户显式救援；之后重开助手重试并清除恢复标记。读回 `0` 不等于已看到导航键，必须确认系统 Home/Back/Recents 和导航可用后再撤权或卸载。进程被杀、强行停止及 ROM 限制不能保证清理回调运行，保留电脑授权或系统设置救援入口。

Shower 依赖隐藏 display/input API 和 ROM 的虚拟屏 Activity 支持；Binder 断开或工具超时不会自动重放动作，应重新 `create` / `screenshot` 检查。虚拟屏预览与触摸、后台定时执行、语音唤醒和朗读仍需模拟器／真机分别验收。

## 自部署 Kokoro 朗读

在设置 → 语音 → 远程朗读模型中选择“使用自部署 Kokoro”，填写该服务的独立 API Key，再把朗读引擎设为远程。预设使用 `model=kokoro`、`voice=zf_xiaoxiao`；音色下拉框提供 8 个固定中文音色。更换接口地址时不会沿用旧服务的密钥。

Kokoro 路径请求流式 PCM（24 kHz、单声道、16 位小端），使用 AudioTrack 边接收边播放，一段回复复用音频输出；停止时取消请求并清空播放缓冲。流式失败会显示错误，不切换系统声音或从头重读。其他模型继续走原有压缩音频播放路径。仅填写模型名不会自动迁移已保存的服务地址或 API Key。

唤醒后的“我在”使用当前朗读配置合成，远程音频首次生成后保存在应用缓存中，后续唤醒直接复用；地址、模型、音色、语速或问候文本变化时生成对应的新缓存。缓存命中时不请求服务，清理应用缓存后会重新生成。系统朗读引擎直接使用系统 TTS。生成失败会提示并继续聆听，不回退到旧录音。

当前自部署服务使用 Kokoro v1.0 权重；音色固定不代表韵律和发音已经通过试听。验收时应测试中文夹英文、数字、长回复、连续打断和网络中断，区分 HTTP 响应头时间、首个音频块时间与手机实际出声时间。

## 源码与许可证

本项目保留 AGPLv3 项目许可及 Ogesture 历史归属，当前已删除其导航手势派生实现；仍包含 Operit Shower 的 LGPL-3.0 派生源码。主项目完整许可证见 [LICENSE](LICENSE)，Operit 许可证副本见 [licenses/Operit-LGPL-3.0.txt](licenses/Operit-LGPL-3.0.txt)；固定上游版本、真实移植文件和修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。分发 APK 时须遵守对应源码与构建材料提供义务，仅给未修改上游链接不足以满足本修改版的义务。

标准 Widget 不授予跨应用自动化权限；Shower 仍需用户明确授予的 Shizuku 权限。应用目录查询保留当前用户可启动应用，工作资料及多用户边界仍受 Android 平台约束。
