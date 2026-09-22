# 项目开发说明

## 目录职责

| 目录 | 内容 |
| --- | --- |
| `app/src/main/` | Android 原生 Java（launcher、手势、Shower、Pi 桥接） |
| `web/src/` | React + TypeScript 前端（聊天、设置，Capacitor 桥接） |
| `pi-runtime/` | Pi coding-agent SDK 集成，esbuild 打包为 `pi-runtime.cjs` |
| `shower-server/` | Binder-only 虚拟屏服务，Gradle 构建后以 `shower-server.jar` 打入 App assets |
| `tests/` | 纯 Java 断言检查（GestureChecks、AgentChecks 等），不依赖 Android stub |
| `app/src/test/` | Robolectric 单元测试 |
| `app/src/androidTest/` | 设备端 instrumentation 检查 |
| `scripts/` | 可重复运行的验证与辅助脚本 |

## 构建先决条件

- **JDK 21**（`JAVA_HOME` 必须指向 JDK 21）
- **Android SDK Platform 36**（`ANDROID_HOME` 未设置时使用 `$env:LOCALAPPDATA\Android\Sdk`）
- **NDK 28.2.13676358、CMake 3.22.1**（构建 node_launcher）
- **Node ≥ 22.19**（前端构建和 pi-runtime）
- Gradle 8.14.3 通过仓库内 `gradlew.bat` 自动下载
- 首次构建需下载 Gradle 发行包、构建依赖和 sherpa-onnx 模型，并接受 SDK 许可

## 构建命令

后台构建统一加上 `--no-daemon --console=plain`，避免 Gradle Daemon 影响后台工具结束判定。通过 PowerShell 包装构建命令时，末尾加上 `exit $LASTEXITCODE`，将 Gradle 退出码传给后台工具。

```powershell
# 环境变量
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "$env:ProgramFiles\Microsoft\jdk-21.0.9.10-hotspot"

# 首次安装前端依赖并同步 Capacitor；之后新增或修改原生插件时重新同步
npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run sync:android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 首次准备 Node Mobile、SDK 和 npm 资源；更新这些资源时重新运行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-pi-runtime.ps1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 日常编译：Gradle preBuild 会重新构建并复制 Web 资源、构建 Pi runtime
.\gradlew.bat build --no-daemon --console=plain
exit $LASTEXITCODE
```

成功构建的调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 按变更范围选择验证

| 改动范围 | 最小验证 |
| --- | --- |
| 纯 Java 逻辑（手势、Agent、搜索） | `scripts/verify.ps1` 中的纯 Java 检查会覆盖 |
| Android 业务逻辑 | `.\gradlew.bat :app:testDebugUnitTest --no-daemon --console=plain`（Robolectric） |
| 前端 TypeScript/React | `npm run build`（tsc + vite） |
| pi-runtime JS | `npm --prefix pi-runtime test` |
| Shower 服务端 | `.\gradlew.bat :shower-server:lintDebug --no-daemon --console=plain` |
| 定时任务 UI | `node scripts/check-schedules.mjs`（浏览器检查，不需要设备） |
| Android 完整检查 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1` |

`scripts/verify.ps1` 执行纯 Java 断言检查、`:app:testDebugUnitTest :app:assembleDebug :app:lintDebug :shower-server:lintDebug`、APK 运行时资源检查、Shower 单 dex 与必需类检查、旧引用检查和空白/行尾风格检查。它不运行 Pi runtime 的 `npm test`、浏览器交互检查或设备检查；涉及这些范围时按表补充。

## 设备验证与自动测试的界限

- 纯 Java 检查和 Robolectric 测试覆盖逻辑正确性，不能证明 WindowManager、MotionEvent、ROM 转场或虚拟屏行为。
- Instrumentation 检查（`ChatStoreChecks`）需要安装应用及测试 APK 的设备或模拟器；其中 `checks=shower-preview` 还需要 Shizuku 已运行并授权。
- 手势、Shower 画面、定时任务后台执行、朗读等功能的最终验收必须在真机上进行，不能仅凭构建通过判定。
- ADB 触摸注入不等于真实手指验收；`input keyevent` 仅证明按键路径。

## 临时文件与密钥

- 设计稿、真机截图、录像、日志和一次性脚本放在**仓库外**的临时目录，不在项目中建立 `design/` 或 `evidence/`。
- 构建与测试的生成文件放在已忽略的 `build/` 目录；可重复运行的验证脚本保留在 `scripts/`。
- **不要提交 `local.properties`**。需要代理时写在用户级 `~/.gradle/gradle.properties`。
- **不要提交或重新生成 `debug.keystore`**；缺失时从其他开发机复制。
