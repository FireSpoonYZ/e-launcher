# Launcher Probe

原生 Java Android 桌面与固定导航手势验证 App，不是 LLM / agent 产品原型。保留默认 HOME 请求、设备信息、按本地语言排序的当前用户应用入口，以及启动失败提示。新增直接适配自 [Ogesture](https://github.com/tanujnotes/Ogesture) 的无障碍手势，不恢复 HyperOS 原生桌面动画。

| 操作 | 固定动作 |
| --- | --- |
| 左/右边缘向内滑，越过阈值后松手 | Back |
| 底边上滑越过阈值后松手 | Home |
| 底边上滑越过阈值并停留约 300ms | 系统最近任务；松手不再 Home |
| App 内“启用手势并隐藏三键” | 创建三个区域后写入 HyperOS 隐藏设置，并读回检查 |
| App 内“停用手势并恢复三键” | 先恢复三键设置并读回，再移除手势区域 |

退出页面、上滑回桌面不会停用。停用不撤销系统里的无障碍授权。不提供手势配置、应用排除、底边横滑切换或动画。左右区域为屏幕高度的80% × 16dp，底部为宽度的80% × 12dp；会随屏幕、旋转与导航栏 inset 更新。窗口不随键盘上移，键盘边缘触摸也可能被截获。

## 构建与检查（Windows PowerShell）

JDK17、Gradle8.11.1、SDK Platform35 / Build Tools35.0.0；AGP8.9.1，minSdk29、targetSdk35。无运行时第三方依赖，不包含 Gradle Wrapper 二进制。首次构建需下载构建依赖并接受 SDK 许可。工具目录与当前开发环境一致：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1
```

脚本设置 `JAVA_HOME=$env:LOCALAPPDATA\e-launcher-tools\jdk-17` 和 `ANDROID_HOME=$env:LOCALAPPDATA\Android\Sdk`，运行纯 Java 断言检查、Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` 以及空白/行尾风格检查。真正的逻辑测试在 `tests/com/example/launcherprobe/GestureChecks.java`，不使用 Android stub 或第三方测试框架；Gradle unit-test 任务目前没有另设的测试源。纯 Java 检查不能证明 WindowManager、MotionEvent 或 ROM 行为。

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

在 App 点击“打开无障碍授权设置”，由用户开启 **Launcher Probe 手势**，返回 App 确认“已连接”和写设置授权，再点击“启用”。服务使用 `TYPE_ACCESSIBILITY_OVERLAY`，不需要普通悬浮窗权限或独立前台服务；不读取窗口内容、不联网，`canPerformGestures` 仅用于回放被边缘区域截获但未识别为导航的单指触摸。取消/多指触摸不回放。

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

## 实机验收进度

当前版本已通过纯 Java 逻辑检查、APK 构建、Android Lint（0 错误、4 警告）和基础格式检查。七项代码审查发现的一项 P1 已修复并通过定向复核。

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

**真实手指测试、ADB 注入触摸、设置值读回分别记录。** `input keyevent` 仅证明按键动作路径，不能冒充手势验收；ADB swipe 也不能代替手指最终验收。

## 源码与许可证

本项目包含 Ogesture 的 AGPLv3 派生源码。完整许可证见 [LICENSE](LICENSE)，固定上游版本、真实移植文件和修改见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。分发 APK 时须遵守对应源码与构建材料提供义务，仅给未修改上游链接不足以满足本修改版的义务。

HOME 身份本身不授予跨应用自动化权限。本 App 不验证 LLM、通知读取、后台启动 Activity 或应用商店分发政策。应用列表在 Activity 创建时读取；工作资料、多用户、快捷方式、小组件仍不在范围。
