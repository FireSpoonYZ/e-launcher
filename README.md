# Launcher Probe

原生 Java Android 桌面、固定导航手势与小型聊天 Agent。保留默认 HOME 请求、按本地语言排序的当前用户应用入口、显式组件启动和失败提示。固定导航手势直接适配自 [Ogesture](https://github.com/tanujnotes/Ogesture)，不恢复 HyperOS 原生桌面动画。

## 聊天与工具

助手使用可配置的 HTTPS OpenAI Chat Completions 兼容端点（默认 `https://api.openai.com/v1`）和经典循环：模型返回 `tool_calls`，App 逐项执行并按调用 ID 回填，直到模型返回无工具调用的最终文本。模型设置和最多 100 条消息保存在应用私有存储；系统备份已关闭。思考强度可选默认/低/中/高：默认不发送额外字段，其余选项向兼容服务发送顶层 `reasoning_effort=low/medium/high`；不支持此参数的模型或服务可能拒绝请求。停止按钮会取消循环并断开当前模型或网页连接。

内置工具为 `list_apps`、`launch_app`、`back`、`home`、`recents`、`read_screen`、`click`、`input_text`、`scroll`、`web_search` 和 `web_fetch`。搜索可选择无需密钥的 [DuckDuckGo Lite](https://lite.duckduckgo.com/lite/)，或用户配置的 SearXNG HTTPS Base URL；二者都返回有长度/数量限制的标题、URL 与摘要，失败不会静默切换服务。SearXNG 通过 `GET /search?q=...&format=json` 请求，配置地址可解析到运营者信任的内网，但任何重定向必须保持同源。通用 `web_fetch` 仍只允许公网 HTTPS，限制超时、重定向和 128 KiB 响应；OkHttp 的自定义 DNS 只把完成公网检查的解析结果交给实际连接。网页、屏幕和工具输出均是不可信数据。屏幕读取最多返回 200 个节点、深度 12，使用单次观察 ID；界面事件或任一动作会使 ID 失效。密码文字会隐藏且拒绝向密码节点自动输入，动作被系统接受后仍须再次读取验证。

当前原生单 Activity 界面提供暖色桌面、本地时间日期、应用图标网格、聊天记录、模型配置与本地应用搜索。发送内容及工具结果会交给用户配置的模型服务；公开网页请求会直接访问相应站点。

“设置”底部面板保留默认桌面请求、系统/无障碍设置入口、固定手势启停、实时状态与 ADB 授权说明。每次 Activity 恢复仍先执行中断恢复检查。

检查脚本验证纯 Java Agent 循环、搜索与手势逻辑、APK 构建和 Lint。2026-09-09 已在 REDMI K80 / Android 16 上完成下述有限范围的 ADB 界面验收；不代表完整手势或所有设备验收通过。

### 新 UI 的 ADB 实机记录（2026-09-09）

- 旧包与新包的 debug 签名不同。经用户确认，先停用旧手势、观察三键并切回系统桌面，再卸载旧包安装当前 APK，重新将本 App 设置为默认 HOME。
- 首页显示真实时间、日期及应用图标；全部应用页显示 176 个启动入口。输入 `settings` 匹配系统设置，点击结果后 UI 层级确认进入 `com.android.settings`。
- 从搜索启动设置后发送 `KEYCODE_HOME`，以及打开本 App 设置面板时发送 Home，均回到首页。键盘显示时发送 Home 后也回到首页。
- 竖屏微信输入法显示时，单个搜索结果可见；全部应用列表能在键盘上方滚动。横屏可显示搜索页；字体比例 1.5 的横屏中，输入区与结果可通过整体滚动到达。横屏输入法自行使用浮动模式，因此该场景不作为停靠式键盘 inset 验收证据。
- 字体比例、旋转设置已恢复为测试前的 `1.0`、竖屏锁定。UI 验收结束时曾保留三键且未恢复卸载清除的授权；随后按用户要求补回无障碍与写设置授权，并从面板启用固定手势。已确认服务绑定、`force_fsg_nav_bar=1`，最终截图 `restored-final.png` 中三键已隐藏（系统手势指示条仍显示）。ADB 左边缘内滑从显示设置返回本桌面，底部短滑从系统设置回到桌面；这两项是注入测试，未代替真实手指或 Recents 完整验收。
- 本次截图、UI XML 和应用日志保存在忽略目录 `evidence/ui-device/`。关键证据：`new-home.png`、`launched-settings.xml`、`after-app-home.xml`、`controls-home.xml`、`portrait-ime.png`、`all-ime-scrolled.png`、`large-font-scrolled.png`、`ui-finished.png`。
- 后续转场对比中，服务原有的 `GLOBAL_ACTION_HOME` 在 HyperOS 上出现跨 task 横移（`home-transition-contact.png`）；通过 shell 显式发送 `ACTION_MAIN + CATEGORY_HOME` 到 `MainActivity` 并加 `FLAG_ACTIVITY_NO_ANIMATION` 后未再横移（`home-noanim-test.png`）。随后覆盖安装修正版，使用 ADB 底部短滑触发真实服务路径；`service-home-final.mp4` 和逐帧图 `service-home-final.png` 显示底部胶囊随拖动移动，松手后直接回到桌面，未再出现横向转场。
- 未覆盖：真实手指体验、TalkBack、API 29、全部应用列表末尾的键盘遮挡、1.5 倍字体与停靠键盘同时显示，以及新版授权后的固定手势启停与恢复。ADB 高速输入曾被输入法转换或打乱，改用英文模式逐字注入后搜索成功；一轮批量滚动误入其他应用，未计为通过证据。

| 操作 | 固定动作 |
| --- | --- |
| 左/右边缘向内滑，越过阈值后松手 | Back |
| 底边上滑越过阈值后松手 | Home |
| 底边上滑越过阈值并停留约 300ms | 系统最近任务；松手不再 Home |
| App 内“启用手势并隐藏三键” | 创建三个区域后写入 HyperOS 隐藏设置，并读回检查 |
| App 内“停用手势并恢复三键” | 先恢复三键设置并读回，再移除手势区域 |

拖动期间会显示独立、不可触摸的轻量无障碍悬浮反馈：左右边缘箭头随有效方向的位移增长，底部 Home 胶囊随上滑进度拉伸，越过动作阈值后变色。反馈窗不加入三个触摸捕获区，不扩大拦截面积；松手、取消、多指、超时、长停触发 Recents、旋转、停用或服务中断都会隐藏。取消/多指仍不回放，未命中的普通单指触摸仍沿原路径回放。

底边 Home 只有在 `RoleManager` 确认本 App 持有默认 HOME 角色时，才由服务显式启动 `MainActivity`，Intent 使用 `ACTION_MAIN + CATEGORY_HOME + FLAG_ACTIVITY_NEW_TASK + FLAG_ACTIVITY_NO_ANIMATION`；不是默认桌面或显式启动异常时仍执行系统 `GLOBAL_ACTION_HOME`，不会劫持其他默认桌面。Activity 收到 HOME Intent 时保留公开转场 API 作为补充，但实机已确认它单独不能消除本机横移。修改后的服务路径已在 REDMI K80 / Android 16 上通过 ADB 短滑和录屏对照验证，不能承诺所有 ROM 均无横移。首页 Back 现在完全无操作，搜索页 Back 只回首页，设置 Dialog 的 Back 仍只关闭 Dialog。

本轮还通过 `feedback-left.png` 确认边缘箭头可见；`home-back-final.mp4` 中连续三次 Back 及一次左边缘返回未使首页退出或横移。底部停留后继续 MOVE/UP，前台保持系统 RecentsActivity，未额外触发 Home；再次短滑可回桌面。最终手势服务仍绑定，隐藏设置为 1。以上均为 ADB 注入证据；真实手指观感、非默认 HOME 回退和异常启动回退仍待进一步验收。

这里的“跟手”仅指本 App 绘制的箭头/胶囊指示器。普通 APK + AccessibilityService 的公开 API 不能逐帧控制其他 App 的任务 Surface，也不能忠实恢复 HyperOS/Quickstep 的窗口缩放回桌面动画；项目不截图或伪造其他 App 窗口；仅在助手工具调用时读取有限的无障碍节点结构。

退出页面、上滑回桌面不会停用。停用不撤销系统里的无障碍授权。不提供手势配置、应用排除或底边横滑切换。左右区域为屏幕高度的80% × 16dp，底部为宽度的80% × 12dp；会随屏幕、旋转与导航栏 inset 更新。窗口不随键盘上移，键盘边缘触摸也可能被截获。

## 构建与检查（Windows PowerShell）

JDK17、Gradle8.11.1、SDK Platform35 / Build Tools35.0.0；AGP8.9.1，minSdk29、targetSdk35。运行时网络使用 OkHttp 3.14.9，不包含 Gradle Wrapper 二进制。首次构建需下载构建依赖并接受 SDK 许可。工具目录与当前开发环境一致：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

脚本设置 `JAVA_HOME=$env:LOCALAPPDATA\e-launcher-tools\jdk-17` 和 `ANDROID_HOME=$env:LOCALAPPDATA\Android\Sdk`，运行纯 Java 断言检查、Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` 以及空白/行尾风格检查。逻辑检查在 `tests/com/example/launcherprobe/GestureChecks.java` 和 `AgentChecks.java`，不使用 Android stub 或第三方测试框架；Gradle unit-test 任务目前没有另设的测试源。纯 Java 检查覆盖反馈进度/阈值与各类清理状态，但不能证明 WindowManager、MotionEvent 或 ROM 转场行为。成功构建的调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 安装与一次授权

先保留三键作为备用导航、关闭 UbikiTouch 等替代工具，以免混淆测试归属。默认桌面由用户通过 HOME 对话框确认，单纯打开 App 不会自动选择默认桌面。

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices -l
$serial = '<已授权设备序列号>'
& $adb -s $serial install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb -s $serial shell pm grant com.example.launcherprobe android.permission.WRITE_SECURE_SETTINGS
& $adb -s $serial shell am start -n com.example.launcherprobe/.MainActivity
```

手机可能要求额外允许 USB 安装/调试安全设置；授权是否被 ROM 接受必须看实际结果。`WRITE_SECURE_SETTINGS` **不是普通运行时权限弹窗可以授予的权限**。本 App 不接入 Shizuku，不尝试自行提权。

在 App 点击“打开无障碍授权设置”，由用户开启 **Launcher Probe 手势**，返回 App 确认“已连接”和写设置授权，再点击“启用”。服务使用 `TYPE_ACCESSIBILITY_OVERLAY`，不需要普通悬浮窗权限或独立前台服务；授权说明会明确窗口结构与节点动作能力，`canPerformGestures` 仅用于回放被边缘区域截获但未识别为导航的单指触摸。取消/多指触摸不回放。

## 启停、安全恢复和已知边界

- 隐藏仅写 `Settings.Global.force_fsg_nav_bar=1`，停用写 `0`，均检查返回值和读回值；不写 `navigation_mode`。这是本项目新增的 HyperOS 适配，不是 Ogesture 的原有能力，也不是通用 Android 保证。
- 显式停用若恢复失败，保留当前可用手势和恢复标记并报错；恢复权限后重试。读回值为0不等于已看到三键，最终必须观察系统界面。不要在确认恢复前卸载或撤权。
- 服务断开/销毁会尽力恢复；**强行停止、系统杀进程、崩溃、断电、撤权、卸载不保证调用清理回调**。无后台轮询看门狗、开机广播或永不被杀承诺。进程中断后下次打开 Activity 或服务重连先尝试恢复三键，成功后保持停用，须再次手动启用。
- 系统主动解除绑定时，即使恢复失败也无法强留服务；待恢复标记会保留。这不同于 App 内主动停用的“先恢复再移除”。
- 未识别的边缘点击/长按/拖动通过无障碍重新注入，会有延迟，不能等同于原生透传。回放期间窗口透明且不接收新触摸；手势取消/旋转/停用会取消尚未发出的回放和停留任务。已经交给系统的注入不能通过本地 Handler 撤回，最多持续3秒；失败会提示。原上游的路径回放也不保留每段采样的精确速度，且只缓存最多400个点。
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

此前原生 HyperOS 限制和第三方 UbikiTouch 测试不能作为本 App 通过的证据。源码、自动检查和构建成功同样不是实机结果。截图/日志存放在被忽略的 `evidence/`，避免提交设备与个人信息。

1. 记录机型/ROM、当前默认桌面、三键状态；关闭其他手势工具。授权前点击启用必须显示缺少权限，不能报告 ON。
2. 在 Probe 默认桌面下启用，观察三键实际消失；左右 Back、底边 Home、停留 Recents 各重复测试，并能点选任务切换。确认没有一次停留触发两项动作。
3. 测试设置子页面、键盘显示/收起、横屏及180°旋转、锁屏解锁、离开 App；测试未识别的边缘点击/长按/拖动。动作失败应在 UI/Toast/logcat 的 `ProbeGestures` 标签可见。
4. 停用和重复启停：先看到三键再停止替代手势。手势中停用/旋转后不得触发旧的 Recents 回调。
5. 进程中断/撤权测试须先准备救援路径并另行确认；重开/重连应先恢复三键，不自动隐藏。
6. 新动画专项：在首页连续 Back 不应有页面或任务变化；搜索页 Back 只回首页一次，设置 Dialog Back 只关闭面板；在首页再次 Home 不应闪烁或重建可见 UI。
7. 从第三方 App 真实手指短上滑回 HOME，分别记录是否仍有 ROM 横向刷入；左右/底部慢拖应在阈值前连续显示箭头/胶囊，跨阈值变色，取消、多指、旋转、停用及 Recents 后不得残留。此项当前未实测。

**真实手指测试、ADB 注入触摸、设置值读回分别记录。** `input keyevent` 仅证明按键动作路径，不能冒充手势验收；ADB swipe 也不能代替手指最终验收。

## 源码与许可证

本项目包含 Ogesture 的 AGPLv3 派生源码。完整许可证见 [LICENSE](LICENSE)，固定上游版本、真实移植文件和修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。分发 APK 时须遵守对应源码与构建材料提供义务，仅给未修改上游链接不足以满足本修改版的义务。

HOME 身份本身不授予跨应用自动化权限。本 App 不验证 LLM、通知读取、后台启动 Activity 或应用商店分发政策。应用列表在 Activity 创建时读取；工作资料、多用户、快捷方式、小组件仍不在范围。
