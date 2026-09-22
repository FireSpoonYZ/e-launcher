# Launcher Probe

原生 Java Android 桌面、固定导航手势与小型聊天 Agent。保留默认 HOME 请求、按本地语言排序的当前用户应用入口、显式组件启动和失败提示。固定导航手势直接适配自 [Ogesture](https://github.com/tanujnotes/Ogesture)，不恢复 HyperOS 原生桌面动画。

## 界面结构

Launcher 首页使用原生 Java Android View；聊天与设置页面使用 Capacitor + React + Tailwind CSS + TypeScript，通过原生插件访问设备与 Pi runtime。前端代码位于 `web/src/`，Android 代码位于 `app/src/main/`。

## Pi Agent 与设置

Pi 模式接入固定版本 **0.85.1** 的完整 coding-agent SDK，提供模型、思考强度、原生工具与扩展、压缩重试、资源及包管理和 OAuth。当前聊天的模型选择与启动默认值分开保存。聊天输入栏的历史分支和思考强度按钮仅在键盘显示时出现；调整思考强度后浮窗保持打开，点击窗外返回输入栏。

独立设置页保留通用、外观、服务商、技能、MCP、扩展、关于七类，其余配置放入高级配置，覆盖文档中的 65 个 settings 字段。全局／工作区表单与 JSON 编辑器共用私有文件；支持自动格式化、未知字段和数字写法保留、草稿、冲突检查及上一版。开放式模型与兼容性结构可直接编辑完整 models.json。

界面支持跟随系统／中英文、浅色／深色、首页图片预览和遮罩。扩展页可直接输入 npm 包名安装，扩展社区使用 npm 公开元数据并提供搜索和分页；配置状态、SDK 找到的安装路径与成功加载分别说明。APK 内置与 Node 24 兼容的官方 npm 11.6.2，无需 Termux 或系统 npm；Git 来源仍需要对应系统命令。安装第三方包可能执行 lifecycle 脚本和代码，请仅使用可信来源。安装成功后会重新读取资源并报告加载、停用／过滤或错误状态，当前聊天下一次发送时使用新扩展。

内置 `conversation-title` 扩展在每轮正常回复完成后生成概括性短标题，对话选择页与首页任务卡共用该标题。在「高级配置 → 模型与思考 → 标题生成模型」填写 `provider/modelId`，也可编辑全局 `~/.pi/agent/settings.json` 或工作区 `.pi/settings.json`：

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

原生首页提供本地时间日期、应用图标网格和输入栏；首页输入栏与 React 聊天输入栏目前是独立实现。点击首页输入栏会聚焦并唤起键盘，非空草稿在点击发送后打开聊天页并提交。

聊天页采用浅灰用户气泡、直接排版的回复、底部圆角输入框与左侧会话抽屉；新会话与未发送草稿独立保存，抽屉可按标题搜索、切换和删除会话。生成期间可切换到其他会话，后台任务继续运行；同一会话一次只运行一轮，删除前须等待任务结束。顶部标题打开模型配置，输入框加号和首页“全部应用”打开本地应用列表，麦克风调用系统语音识别，回复支持复制与系统分享。发送内容及工具结果会交给用户配置的模型服务；公开网页请求会直接访问相应站点。

“设置”底部面板保留默认桌面请求、系统/无障碍设置入口、固定手势启停、实时状态与 ADB 授权说明。每次 Activity 恢复仍先执行中断恢复检查。

### 任务详情与实时桌面

首页任务卡不显示虚拟桌面；点击标题进入详情页后，有关联虚拟屏的会话优先显示大画面，任务步骤和最新回复可从底部展开。画面使用 Android `VirtualDisplay.setSurface` 直接送入本机 `TextureView`，无截图轮询、网络传输或额外视频解码。画面按实际虚拟分辨率等比显示，可切换全屏；返回详情或切换应用后会解绑预览并恢复原 Surface，AI 截图和原屏幕继续可用。详情页只观察已存在的虚拟屏，不启动 Node、Shizuku 或新建屏幕。

点击「接管操作」后可直接点击、长按、拖动、滑动和多指操作。该会话后续的 `shower` 工具调用等待接管结束；已等待的非截图操作不会直接重放，而是提示 AI 先截图重新定位。结束接管、离开详情或画面释放都会解除等待。导航栏提供虚拟屏返回、应用列表、最近打开的应用和文字输入；最近应用来自本虚拟屏成功启动记录，不是手机系统任务列表。应用列表替代全局 HOME/RECENTS，避免某些 ROM 将按键送往主屏。文字输入可替换当前焦点输入框（最多 1000 字符），并提供退格、回车。页面给手机系统侧边和底部手势留出空间。

模拟器／设备检查需已运行并授权 Shizuku，安装 `:app:assembleDebug` 和 `:app:assembleDebugAndroidTest` 的 APK 后执行：

```powershell
& $adb shell am instrument -w -e checks shower-preview com.example.launcherprobe.test/com.example.launcherprobe.ChatStoreChecks
```

此检查使用临时会话和系统设置应用，不调用模型；验证连续画面、触摸后画面变化、预览期间 AI 截图及退出后继续操作。测试会删除临时会话，截图保存在设备应用外部文件目录的 `shower-preview-check.png`。已在 Android 16 模拟器验证；真机刷新率、键盘与 ROM 差异仍需设备验收。

### 定时任务

聊天页左侧会话抽屉的「新会话」下方提供「定时任务」入口。管理页支持创建、编辑、启用／暂停、删除及执行记录；周期设置与主表单共用一个底部面板，返回时保留主表单，关闭未保存的修改时会确认。助手内置 `schedule_task`，可 list、create、update 和 delete。update 只提交要改的字段，宿主按当前 revision 合并未提供的规则并保留启用或暂停；revision 不一致或任务已删除会返回错误，不会自动再提交一次。返回里的 `exactAlarmGranted` 为 false 或 `schedulingError` 非空只表示任务已保存，精确闹钟尚未排上，不能当成到点一定会执行。

- **每天**：指定时、分。
- **每周**：指定周一至周日中的一天及时间。
- **每月**：指定 1–31 日及时间；当月没有该日期时跳过当月。例如每月 31 日在 4 月不执行，下一次为 5 月 31 日。

工作日和非工作日暂未加入。时间跟随设备时区，界面通过原生规则预览下次执行；修改系统时间或时区后重新安排。夏令时不存在的本地时间由 `java.time` 向后调整，重复的本地时间只选择第一次。

任务使用 Android `AlarmManager` 精确闹钟调度，定义和执行记录保存于应用私有存储。Android 12 及以上需要用户在「闹钟与提醒」中授权；未授权时可保存任务，但页面会明确显示等待授权。恢复授权、重启设备或更新应用后重新安排未来任务，不从开机广播直接启动 Agent，也不补跑恢复时已过期的任务。系统迟到的闹钟最多执行一次，不重放此前的多次周期；上一次同名定时定义仍在执行时跳过本次并记录原因。

每次执行创建独立会话，使用全局默认模型，不改变当前聊天或未发送草稿。执行结果可在「执行记录」中打开对应会话；保留最近 100 条记录，尚在运行的记录不提前移除。暂停和删除只影响未来调度，不停止已经开始的执行，也不删除会话或历史。执行失败不自动重试外部操作；用户强行停止应用、撤销权限及系统后台限制仍可能阻止或中断执行，恢复时会显示中断或跳过记录。

浏览器界面检查：`node scripts/check-schedules.mjs`，使用 Chrome／Edge 和内存原生桥接样例验证真实 React 页面，截图保存到系统临时目录；`--serve` 可打开本地设计对照页面。此检查不会创建 Android 闹钟或调用模型，不能替代真机后台执行验证。原生周期和持久化回归见 `ScheduleRuleTest` 与 `ScheduledTasksTest`。

检查脚本验证纯 Java Agent 循环、搜索与手势逻辑、APK 构建和 Lint。历史设计稿及本地截图、录像、日志已清理；设备验证范围见下文，不能据此认定所有机型和场景均已通过。

| 操作 | 固定动作 |
| --- | --- |
| 左/右边缘向内滑，越过阈值后松手 | Back |
| 从底边按下后 200 ms 内（含 200 ms）松手，上滑至少 10 dp | Home |
| 从底边按下后持续按住超过 200 ms，不要求停止移动或达到滑动距离 | 独立应用切换页；松手不再 Home |
| App 内“启用手势并隐藏三键” | 创建三个区域后写入 HyperOS 隐藏设置，并读回检查 |
| App 内“停用手势并恢复三键” | 先恢复三键设置并读回，再移除手势区域 |

拖动期间会显示独立、不可触摸的轻量无障碍悬浮反馈：左右边缘使用贴边箭头与轨迹，底部使用固定在屏幕底部中央的上滑轨迹与轮廓，不再让小反馈窗追随触点漂移；有效位移采用缓出进度，越过动作阈值后变色，结束时短暂消散。反馈窗不加入三个触摸捕获区，不扩大拦截面积；松手、取消、多指、超时、停留触发应用切换、旋转、停用或服务中断都会隐藏。取消/多指仍不回放，未命中的普通单指触摸仍沿原路径回放。

底边 Home 只有在 `RoleManager` 确认本 App 持有默认 HOME 角色时，才由服务显式启动 `MainActivity`，Intent 使用 `ACTION_MAIN + CATEGORY_HOME + FLAG_ACTIVITY_NEW_TASK + FLAG_ACTIVITY_NO_ANIMATION`；不是默认桌面或显式启动异常时仍执行系统 `GLOBAL_ACTION_HOME`，不会劫持其他默认桌面。Activity 收到 HOME Intent 时保留公开转场 API 作为补充，但实机已确认它单独不能消除本机横移。修改后的服务路径已在 REDMI K80 / Android 16 上通过 ADB 短滑和录屏对照验证，不能承诺所有 ROM 均无横移。首页 Back 现在完全无操作，搜索页 Back 只回首页，设置 Dialog 的 Back 仍只关闭 Dialog。

应用切换页使用本桌面的成功启动记录，按最近使用排序，过滤本启动器及已卸载或不可启动的应用；它不是系统任务列表。页面使用真实图标和应用封面，提供横向跟手滑动、卡片缩放/倾斜、弹性吸附、错峰入场及点击展开动效；关闭返回原页面，空记录可回到桌面。无障碍翻页及系统关闭动画的设置同样生效。独立 Activity 不留在系统最近任务中，离开后不保留；助手的 `recents` 工具仍请求系统最近任务。

边缘手势的“跟手”仅指本 App 绘制的箭头/胶囊指示器。普通 APK + AccessibilityService 的公开 API 不能逐帧控制其他 App 的任务 Surface，也不能忠实恢复 HyperOS/Quickstep 的窗口缩放回桌面动画；项目不截图或伪造其他 App 窗口；仅在助手工具调用时读取有限的无障碍节点结构。

退出页面、上滑回桌面不会停用。停用不撤销系统里的无障碍授权。不提供手势配置、应用排除或底边横滑切换。左右区域为屏幕高度的80% × 24dp，底部为宽度的80% × 12dp；会随屏幕、旋转与导航栏 inset 更新。窗口不随键盘上移，键盘边缘触摸也可能被截获。

应用切换的当前设备验证：REDMI K80 上通过 ADB 注入触摸确认按住时进入、松手后仍停留、横滑切换、点击启动、Back 返回进入前的应用及快速上滑回桌面；退出后没有残留切换 Activity。自动检查覆盖取消/多指、单应用/空记录、横屏布局与关闭系统动画。ADB 注入结果不等于真实手指手感验收。

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
.\gradlew.bat build
```

需要完整检查时再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

脚本要求 `JAVA_HOME` 指向 JDK 21，`ANDROID_HOME` 未设置时使用 `$env:LOCALAPPDATA\Android\Sdk`，并通过仓库内 `gradlew.bat` 运行纯 Java 断言检查、Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug :shower-server:lintDebug`、Shower 单 dex/必需类与旧 Lamda 引用检查，以及空白/行尾风格检查。逻辑检查在 `tests/com/example/launcherprobe/GestureChecks.java` 和 `AgentChecks.java`，不使用 Android stub 或第三方测试框架；Gradle unit-test 任务运行 `app/src/test` 下的 Robolectric 回归，覆盖凭据、请求持久化、设置重建和公开元数据边界；Windows 测试仅适配 AtomicFile 的底层替换操作，不替换业务逻辑。纯 Java 检查覆盖反馈进度/阈值与各类清理状态，但不能证明 WindowManager、MotionEvent 或 ROM 转场行为。成功构建的调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

日常开发在 `develop`。每次 push 会构建 debug APK，在对应 GitHub Actions run 的 Artifacts 里下载，保留 7 天。合并或推到 `main` 时额外构建 release APK，并覆盖 GitHub Release [`latest`](https://github.com/FireSpoonYZ/e-launcher/releases/tag/latest)。CI 需要仓库 secret `DEBUG_KEYSTORE_BASE64`（项目根目录 `debug.keystore` 的 base64）。

纯 Java 检查的编译产物位于 `build/test-classes/`。思考强度浮窗的真机触摸回归脚本为 `scripts/check-thinking-slider.mjs`，设备连接和运行方式见文件开头的说明。

### 跨电脑使用同一开发签名

Debug 构建固定使用项目根目录的 `debug.keystore`，不再使用各电脑自动生成的 `~/.android/debug.keystore`。该文件已加入 `.gitignore`，需要通过私密渠道将**同一份文件**复制到其他电脑的项目根目录；缺失时 Gradle 会报错，不会自动生成替代密钥。首次配置沿用本机已有开发密钥，因此签名与本机此前构建的 APK 一致。

这是标准 Android debug 密钥，别名为 `androiddebugkey`，存储和密钥密码均为公开默认值 `android`，仅用于开发，不用于正式发布。本地 debug 构建和 CI 的 debug/release APK 都用这一份密钥，因此可以互相覆盖安装。不要在另一台电脑重新生成密钥或随意替换此文件，否则旧签名的应用无法覆盖更新。当前开发证书 SHA-256：

```text
6f6ff43d800aa2eb8444a78d4f3992a0157f5bae2ca0a31a97da753187d01ffb
```

## 安装与一次授权

先保留三键作为备用导航、关闭 UbikiTouch 等替代工具，以免混淆测试归属。默认桌面由用户点击设置页“使用 Shizuku 设为默认桌面”，通过已授权的 Shizuku 为本应用设置 HOME 角色并读回确认；单纯打开 App 不会自动选择默认桌面。“默认桌面设置 / 恢复系统桌面”仍可打开系统设置。

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices -l
$serial = '<已授权设备序列号>'
& $adb -s $serial install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb -s $serial shell pm grant com.example.launcherprobe android.permission.WRITE_SECURE_SETTINGS
& $adb -s $serial shell am start -n com.example.launcherprobe/.MainActivity
```

手机可能要求额外允许 USB 安装/调试安全设置；授权是否被 ROM 接受必须看实际结果。`WRITE_SECURE_SETTINGS` **不是普通运行时权限弹窗可以授予的权限**。也可安装并启动官方 Shizuku：App 首次检测到 Shizuku 后会请求本 App 的 Shizuku 授权；授权后通过受限 UserService 为本包执行固定的 `WRITE_SECURE_SETTINGS` 授权；设置默认桌面则仅在点击对应按钮后执行本包的 `cmd role add-role-holder` 命令。自动修复会检查权限，并保留其他无障碍服务来修复 **Launcher Probe 手势**。设置页“使用 Shizuku 修复授权与无障碍”可重试；状态以权限读回、系统启用列表及服务真实连接为准。Shizuku 未运行、拒绝或 ROM 阻止命令时会显示失败，不持续后台轮询。

首次启用仍须用户点击“启用固定导航手势”。之后覆盖安装或无障碍重连会按恢复标记自动继续隐藏三键并启动手势；也可点击“打开无障碍授权设置”手动处理。服务使用 `TYPE_ACCESSIBILITY_OVERLAY`，不需要普通悬浮窗权限或独立前台服务；授权说明会明确窗口结构与节点动作能力，`canPerformGestures` 仅用于回放被边缘区域截获但未识别为导航的单指触摸。取消/多指触摸不回放。Operit Shower 复用同一份用户明确授予的 Shizuku 权限，但仅在 Pi 调用 `shower create` 时启动；`release` 会销毁虚拟屏并停止本应用拥有的 Shower PID，不使用端口服务、共享下载目录或宽泛 `pkill`。

## 启停、安全恢复和已知边界

- 隐藏仅写 `Settings.Global.force_fsg_nav_bar=1`，停用写 `0`，均检查返回值和读回值；不写 `navigation_mode`。这是本项目新增的 HyperOS 适配，不是 Ogesture 的原有能力，也不是通用 Android 保证。
- 显式停用若恢复失败，保留当前可用手势和恢复标记并报错；恢复权限后重试。读回值为0不等于已看到三键，最终必须观察系统界面。不要在确认恢复前卸载或撤权。
- 覆盖安装或服务断开只摘下手势窗口，不把三键写回来；下次 Activity 打开且无障碍连上后按恢复标记重新隐藏并启动。点“停止手势并恢复三键”才写 `0`。**强行停止、系统杀进程、崩溃、断电、撤权、卸载不保证调用清理回调**；无后台轮询看门狗。若进程死掉且再也打不开本应用，可能暂时既无三键也无手势，用下面的 ADB 救援。
- 系统主动解除绑定时无法强留服务；待恢复标记会保留，重连后继续全面屏而不是先恢复三键。这不同于 App 内主动停用的“先恢复再移除”。
- 未识别的边缘点击/长按/拖动通过无障碍重新注入，会有延迟，不能等同于原生透传。回放期间窗口透明且不接收新触摸；手势取消/旋转/停用会取消尚未发出的回放和停留任务。已经交给系统的注入不能通过本地 Handler 撤回，最多持续3秒；失败会提示。原上游的路径回放也不保留每段采样的精确速度，且只缓存最多400个点。
- Shower 依赖 Android 的隐藏 display/input API、硬件 H.264 encoder 和 ROM 对虚拟屏启动 Activity 的支持。工具超时或 Binder 断开后不会自动重放动作；重新 `create` / `screenshot` 检查。桌面构建与模拟桥接测试不等于真机虚拟屏验证。
- 无障碍悬浮窗属于平台 trusted window，但不保证所有设置/安全页面、锁屏、键盘、横屏都可操作。任何隐藏三键后没有可用导航的界面都是本轮验收阻断项。

ADB 救援（保持电脑授权和连接；若设备不接受命令，从通知栏进入系统导航设置）：

```powershell
& $adb -s $serial shell settings put global force_fsg_nav_bar 0
& $adb -s $serial shell settings get global force_fsg_nav_bar
& $adb -s $serial shell am start -a android.settings.SETTINGS
```

恢复后在 App 点“停用”清理恢复标记，再通过“打开默认桌面设置 / 恢复系统桌面”选择原系统桌面。确认 Home/Back/Recents 和三键可用后，才考虑卸载；不要禁用或卸载系统桌面。

## 固定手势历史验收进度（UI 改版前）

当时版本已通过纯 Java 逻辑检查、APK 构建、Android Lint（0 错误、4 警告）和基础格式检查。七项代码审查发现的一项 P1 已修复并通过定向复核。

在 REDMI K80、Android 16 / HyperOS 3 上，已停用 UbikiTouch，并将本 App 设为默认桌面。已通过 ADB 触摸注入检查：无障碍未连接或写设置权限不足时不启动；点击启用后三键消失；左右内滑各两次从深色模式设置返回显示设置；底部短滑回到本 App 桌面。无障碍服务绑定和写设置授权也已核实。

上滑停留 Recents、停用后实际显示三键、重复启停、键盘、横屏、锁屏和真实手指体验仍待验收。当前结果不代表完整实机验收通过。

### 已记录的低优先级问题

- 仅在最终松手坐标越过阈值的滑动可能漏识别。
- 未识别拖动若回到起点，回放可能被误判为点击或长按。
- 存在无人读取、与真实运行状态不一致的 `enabled` 偏好写入。
- 恢复失败后的降级提示可能被迟到的回放取消提示覆盖；恢复责任标记和非正常 ON 状态仍保留。

### 后续验收步骤

此前原生 HyperOS 限制和第三方 UbikiTouch 测试不能作为本 App 通过的证据。源码、自动检查和构建成功同样不是实机结果。新的截图和日志应保存在仓库外的临时目录。

1. 记录机型/ROM、当前默认桌面、三键状态；关闭其他手势工具。授权前点击启用必须显示缺少权限，不能报告 ON。
2. 在 Probe 默认桌面下启用，观察三键实际消失；左右 Back、底边 Home、停留打开应用切换各重复测试，并能点选应用打开。确认没有一次停留触发两项动作。
3. 测试设置子页面、键盘显示/收起、横屏及180°旋转、锁屏解锁、离开 App；测试未识别的边缘点击/长按/拖动。动作失败应在 UI/Toast/logcat 的 `ProbeGestures` 标签可见。
4. 停用和重复启停：先看到三键再停止替代手势。手势中停用/旋转后不得触发旧的停留回调。
5. 进程中断/撤权测试须先准备救援路径并另行确认；重开/重连应先恢复三键，不自动隐藏。
6. 新动画专项：在首页连续 Back 不应有页面或任务变化；搜索页 Back 只回首页一次，设置 Dialog Back 只关闭面板；在首页再次 Home 不应闪烁或重建可见 UI。
7. 从第三方 App 真实手指短上滑回 HOME，分别记录是否仍有 ROM 横向刷入；左右/底部慢拖应在阈值前连续显示箭头/胶囊，跨阈值变色，取消、多指、旋转、停用及 Recents 后不得残留。此项当前未实测。

**真实手指测试、ADB 注入触摸、设置值读回分别记录。** `input keyevent` 仅证明按键动作路径，不能冒充手势验收；ADB swipe 也不能代替手指最终验收。

## 自部署 Kokoro 朗读

在设置 → 语音 → 远程朗读模型中选择“使用自部署 Kokoro”，填写该服务的独立 API Key，再把朗读引擎设为远程。预设使用 `model=kokoro`、`voice=zf_xiaoxiao`；音色下拉框提供 8 个固定中文音色。更换接口地址时不会沿用旧服务的密钥。

Kokoro 路径请求流式 PCM（24 kHz、单声道、16 位小端），使用 AudioTrack 边接收边播放，一段回复复用音频输出；停止时取消请求并清空播放缓冲。流式失败会显示错误，不切换系统声音或从头重读。其他模型继续走原有压缩音频播放路径。仅填写模型名不会自动迁移已保存的服务地址或 API Key。

唤醒后的“我在”使用当前朗读配置合成，远程音频首次生成后保存在应用缓存中，后续唤醒直接复用；地址、模型、音色、语速或问候文本变化时生成对应的新缓存。缓存命中时不请求服务，清理应用缓存后会重新生成。系统朗读引擎直接使用系统 TTS。生成失败会提示并继续聆听，不回退到旧录音。

当前自部署服务使用 Kokoro v1.0 权重；音色固定不代表韵律和发音已经通过试听。验收时应测试中文夹英文、数字、长回复、连续打断和网络中断，区分 HTTP 响应头时间、首个音频块时间与手机实际出声时间。

## 源码与许可证

本项目包含 Ogesture 的 AGPLv3 派生源码，以及 Operit Shower 的 LGPL-3.0 派生源码。主项目完整许可证见 [LICENSE](LICENSE)，Operit 许可证副本见 [licenses/Operit-LGPL-3.0.txt](licenses/Operit-LGPL-3.0.txt)；固定上游版本、真实移植文件和修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。分发 APK 时须遵守对应源码与构建材料提供义务，仅给未修改上游链接不足以满足本修改版的义务。

HOME 身份本身不授予跨应用自动化权限。本 App 不验证 LLM、通知读取、后台启动 Activity 或应用商店分发政策。应用列表在 Activity 创建时读取；工作资料、多用户、快捷方式、小组件仍不在范围。
