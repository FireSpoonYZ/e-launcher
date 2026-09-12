# 迁移实施记录

本次页面由主助手按 `image-to-code` 亲自实现。此前的 React worker 已停止，未重新启动。设计依据见 [visuals/DESIGN.md](visuals/DESIGN.md)，实际手机截图保存在 [device/](device/)。迁移尚未全部收尾。

## 已落地代码

- `web/src/main.tsx`：先读取 Android 入口，再挂载路由，避免默认聊天路由覆盖设置入口。
- `web/src/App.tsx`：HashRouter、设备偏好、系统栏、可见视口及统一返回处理。
- `web/src/Chat.tsx`：聊天、Markdown/GFM/公式、工具展开、复制/分享、草稿、语音、应用选择、会话抽屉、模型与真实 thinking 能力、历史树与显式续接。
- `web/src/Settings.tsx`：设置目录、语言、运行模式、外观、背景、桌面/手势与关于。
- `web/src/Resources.tsx`：真实服务商目录、凭据表单、动态认证问题、资源诊断、包操作及 npm 社区搜索分页。
- `web/src/Editor.tsx`：schema 分组字段、全局/工作区、文件编辑、格式化、导入/导出、上一版、原生草稿与 CAS。
- `web/src/ui.tsx`、`components/ui/dialog.tsx`、`styles.css`：共享组件及从设计图提取的颜色、字体、间距、平面列表和面板。
- 原生 Capacitor 容器和 Chat/Settings/Device 插件继续调用既有存储与 runtime。聊天执行归应用进程所有，前端不保存最终会话或凭据到 localStorage。

原生接口补充了：原样 JSON 字段值、必传编辑 base、凭据文件上一版授权、默认 provider 信息掩码、编辑 provider 时保留已有模型高级定义与数字、持久终态错误、请求 token 所有权、键盘隐藏和系统字体缩放。

## 已执行检查

前端类型检查与 Vite 构建、Capacitor 同步、Android `assembleDebug`、`lintDebug`、现有 `testDebugUnitTest` 均通过。`git diff --check` 通过。没有新增 UI 测试。

Windows 构建入口：

```powershell
$env:ANDROID_HOME = 'C:\Users\46040\AppData\Local\Android\Sdk'
npm run build
npx cap sync android
& './.pi/tools/gradle-8.14.3/bin/gradle.bat' --no-daemon :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
```

此前失败已修复：Windows shell 使用 Gradle `.bat` 入口；为构建设置 SDK 路径；`settings.gradle` 加载 Capacitor 生成的全部插件模块。

## 手机检查

设备：24117RK2CC / Android 16 / API 36，WebView 142.0.7444.174。覆盖安装保留 application ID `com.example.launcherprobe` 和原有数据。

已实际观察：

- Launcher 设置入口进入 `#/settings`，保持 HOME role。
- 键盘打开时按 Back 仅隐藏键盘，WebAppActivity 保持打开。设备先发 viewport resize、再发返回事件，协调器据此避免同一次返回继续关闭容器。
- 模型目录加载并展示真实模型及 thinking 档位。
- 文件编辑添加尾部空白后，离开提示出现；选择保留草稿后，重新进入恢复修改状态；保存后草稿清除。
- 点击历史节点仅改变预览，不改变原生 leaf；用户节点动作是“编辑并续接”。
- 资源页显示原有 `npm:pi-web-access` 0.29.0；修复包列表 `user` 与资源列表 `global` 的作用域命名差异。
- 社区查询成功返回 20 条真实结果。
- 新建验证会话，通过 React 发送“请只回复一句：界面已连接。不要调用工具。”后立即 HOME。进程保持存活；重新进入后状态为 completed，回复“界面已连接。”，两条消息均为完整消息，无重复发送。
- 验证会话随后删除，原会话重新选中，原有 9 个会话保留。主题恢复 `system`，未更新或卸载原有包。

最后覆盖安装的 APK：`app/build/outputs/apk/debug/app-debug.apk`，48,439,185 字节。一次设备 Web 导航记录 DOMContentLoaded 约 219.7 ms、load 约 219.9 ms；这是 Web 导航时长，不是完整冷启动或触摸至可交互时长。一次设置页进程内存快照 PSS 180,722 KiB、RSS 392,960 KiB，不构成稳定性能基准。

## 尚未完成

- 清理已被替代的原生聊天/设置绘制代码、旧 PiSettingsActivity 注册和只服务旧 UI 的依赖。首页历史/模型按钮已改走 React，但旧方法体仍保留在源码中。
- 完整设备验收仍需覆盖：长时间流式输出与取消、进程终止恢复、实际 OAuth 授权完成、包安装/更新/移除、配置竞争冲突、旋转/大字体/TalkBack，以及 API 29 设备。
- 高级模型/兼容参数目前通过完整文件编辑入口处理；部分页面的英文元数据与细节布局仍需检查。
- 本轮 LSP 没有返回可用的语言服务器诊断；前端依赖 TypeScript 检查结果，Android 依赖 Gradle 编译与 Lint 结果。

不能将上述尚未执行的检查解释为通过，也不能将设计图视为实际设备验收截图。
