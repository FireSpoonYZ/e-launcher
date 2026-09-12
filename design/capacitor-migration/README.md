# 非 Launcher 界面迁移到 Capacitor + React

状态：迁移实施中。React 页面与 Capacitor 接口已落地并覆盖安装到设备，旧 UI 清理与完整验收尚未结束。实际代码、构建和手机检查结果见 [实施记录](IMPLEMENTATION.md)。本文其余章节保留迁移方案及规划时的工程基线。

## 1. 结论与范围

可以实现。采用 **原生 Android Launcher + Capacitor 容器 + React + TypeScript + Tailwind CSS**，保留一个 APK、现有应用 ID 和现有 Android 工程。

Launcher 继续使用 Java 和 Android 原生 View；除 Launcher 外，本应用自行绘制的页面、表单、抽屉和弹窗统一由 React 实现。Capacitor 管理 WebView、网页资源和 JavaScript/原生通信。原生功能通过本地 Capacitor 插件提供给 React。

“非 Launcher 全部迁移”指这些功能的界面及前端交互迁移，不意味着把系统权限、无障碍服务、Node 进程、模型执行和文件存储全部重写为浏览器 TypeScript。Android 系统授权页、系统文件选择器、系统分享面板和外部浏览器仍由系统提供。

与仅替换聊天页相比，本次范围还包括完整设置、服务商与模型配置、技能、MCP、扩展、OAuth 交互、历史树和高级配置编辑。范围扩大后，Capacitor 的统一插件接口和生命周期支持有实际价值，因此按本方案采用 Capacitor。

### 1.1 界面设计方向与实现方式

参考 **Pi WebUI、ChatGPT App 和 Pi Desktop** 的界面与交互，结合本项目的聊天、工具调用、会话树和设置功能，重新设计非 Launcher 区域的 WebView 前端。以手机 App 的使用体验为优先，融入适合单手操作的导航、底部输入区、抽屉与底部面板、触控反馈和自然转场，并统一字体、间距、图标、浅色与深色主题。布局需适配手机屏幕、系统安全区、软键盘和字体缩放。

设计与实现采用 **`image-to-code` skill**：先梳理参考界面，生成主要页面及关键交互状态的设计图，再分析布局、组件和视觉细节，使用 React + TypeScript + Tailwind CSS 在 Capacitor WebView 中实现。复杂页面和局部细节分别生成清晰可读的设计图；实现后对照设计图与设备截图检查并迭代，确保视觉一致、交互完整，同时保留本方案规定的业务能力与原生边界。

## 2. 当前工程事实

| 项目 | 当前实现 |
| --- | --- |
| 应用 | `com.example.launcherprobe`，单一 Android `:app` 模块 |
| 宿主 | Java + Android 原生 View，无 React Native、Compose 或 Capacitor |
| HOME 入口 | `MainActivity`，同时声明 HOME/LAUNCHER，`launchMode="singleTask"` |
| 聊天 UI | `MainActivity.showSearch()`、输入栏、会话抽屉、`ConversationTreeSheet` |
| 设置 UI | `PiSettingsActivity`，以及 `MainActivity` 中的设置弹窗 |
| 会话存储 | `ChatStore`、应用私有 SharedPreferences、Pi 会话上下文文件 |
| Pi 配置 | `PiConfigStore`，保留原子写入、冲突检查、上一版与草稿语义 |
| 模型执行 | Android Agent 路径，以及 `PiAgentBridge` 连接的内嵌 Node/Pi runtime |
| 当前 WebView | 尚未引入，没有网页消息桥 |
| 构建基线 | JDK 17、Gradle 8.11.1、AGP 8.9.1、compile/target SDK 35、min SDK 29 |
| 原生 runtime | arm64、NDK/CMake、Node Mobile launcher；构建入口见 `pi-runtime/README.md` |

`PiAgentBridge` 是 Java 与 Node 的 socket bridge，不是浏览器桥。`pi-runtime` 的 esbuild 产物面向 Node，不能加载进 WebView 充当前端。

现有详细行为以 [Pi 设置设计](../pi-settings/README.md)、[会话树设计](../session-tree/README.md)、[运行时与构建说明](../../pi-runtime/README.md) 和实际代码为准。

## 3. 技术栈

| 层级 | 选择 | 说明 |
| --- | --- | --- |
| Android 容器 | Capacitor Android，`BridgeActivity` | 使用官方容器及插件生命周期 |
| 前端 | React + TypeScript | 统一非 Launcher 页面与交互 |
| 构建 | Vite | 生成随 APK 打包的静态资源 |
| 样式 | Tailwind CSS | 统一主题、间距、响应式布局及交互状态 |
| 路由 | React Router，采用 HashRouter | 管理聊天、设置、编辑器等本地页面 |
| 基础组件 | shadcn/ui，按需引入 | 用于对话框、菜单、表单等；可直接修改组件源码 |
| 原生通信 | 本地 Capacitor Java 插件 + TypeScript 类型定义 | 替代单独手写的 WebView 消息桥 |
| 前端状态 | React state/reducer/context 起步 | 原生保存业务事实，React 保存显示状态与编辑缓冲 |
| Markdown | `react-markdown` + `remark-gfm` | 保留代码、表格和任务列表；按现有功能补公式支持 |
| 验证 | 现有 Java/Node 检查 + 前端类型检查、构建和必要行为测试 | 浏览器测试不替代设备上的插件与 HOME 验收 |

Capacitor 不要求使用 Ionic React；本方案不引入 Ionic 页面与导航体系。也不需要 Next.js、SSR 或新的 HTTP 服务。前端直接调用 Capacitor 插件，模型请求继续由现有执行层处理。

完整消息、工具详情、历史树和设置有较强项目语义，首期用 React 组件接现有数据，不强制引入 AI SDK 的消息运行时或另一套会话状态模型。长会话若出现实测性能问题，再按需引入消息虚拟列表。

### 3.1 版本与环境基线

建议以 **Capacitor 8.x、React 19.x、Tailwind CSS 4.x、TypeScript 5.x** 为初始选型；Vite 选择与所锁定 Node 和 React 工具链兼容的稳定版本。实际安装时锁定具体版本与 lockfile，不依赖浮动 `latest` 构建。

Capacitor `core`、`android`、`cli` 使用一致版本，官方插件选择兼容的大版本。版本基线需要在接入验证阶段落实：

| 项目 | 接入要求 |
| --- | --- |
| 开发机 Node | Capacitor 8 要求 Node 22+；还需满足项目 runtime 的 Node >= 22.19 及所选 Vite 要求，统一选满足三者的 LTS |
| JDK | 采用 JDK 21；Capacitor 8 Android 模块使用 Java 21 编译目标 |
| Android 工具链 | 按 Capacitor 8 官方迁移基线升级 AGP 8.13.0、Gradle 8.14.3、compile/target SDK 36，并同步验证脚本 |
| min SDK | 保留项目现有 29，高于 Capacitor 8 的 24 基线 |
| WebView | Tailwind 4 基础浏览器要求包含 Chrome 111+；按实际 CSS 功能核对 Android System WebView，不以 Android 系统版本代替引擎版本 |
| Android Studio | 使用满足 Capacitor 8 官方要求的版本；官方基线为 Otter 2025.2.1+ |

Android 10 / API 29 不等于设备已安装足够新的 WebView。首期明确将 Chromium 111+ 作为 Tailwind 4 的候选最低引擎要求，并在目标设备验证；使用更新 CSS 功能时相应提高要求。若产品必须覆盖不可更新的老 WebView，再调整 Tailwind 版本或样式方案。

升级 target SDK 会影响 edge-to-edge、返回导航和窗口行为；JDK 升级会影响现有验证脚本。保留 Node Mobile、NDK/CMake 和 native library 打包逻辑，在接入阶段实际构建检查，不能把接入理解为仅添加几个 npm 包。

## 4. Launcher 与 React 的边界

### 4.1 保留原生的 Launcher

- HOME/LAUNCHER 入口、默认桌面角色、`singleTask` 和 HOME Intent 处理。
- 首页时间、日期、背景、应用图标网格、应用启动和桌面手势。
- Launcher 的全部应用抽屉与本地应用搜索，按桌面功能保留原生。
- `GestureService`、Shizuku、权限修复、服务状态检查和手势中断恢复。
- 首页 Back 无动作、Home 返回首页及现有转场语义。

首页的聊天入口仍属于 Launcher：可保留轻量原生输入入口，草稿与当前会话使用同一存储；点击发送后打开 React 聊天页并只提交一次。聊天页的完整输入框归 React。

现有首页与聊天页“共享同一个原生输入栏实例”的实现无法跨独立 Capacitor Activity 原样保留。迁移后保留草稿、视觉位置和发送语义，通过转场衔接；不再要求共享 View 实例。原生首页和 Web 页面应共同读取主题、语言、背景等偏好。

### 4.2 全部迁移为 React 的应用 UI

| 范围 | React 实现内容 | 原生提供的能力 |
| --- | --- | --- |
| 聊天 | 消息、输入框、模型/思考强度、流式内容、工具详情、复制/分享入口 | Agent 执行、取消、语音、分享 |
| 会话管理 | 抽屉、搜索、新建、切换、删除确认、分支树、预览、编辑与续接 | `ChatStore` 与 Pi 上下文读写 |
| 设置 | 通用、外观、服务商、技能、MCP、扩展、关于、高级配置 | 配置与运行状态读写 |
| 高级配置 | 全局/工作区、分组字段、完整 JSON、文件编辑器、格式化、草稿/冲突/上一版 | `PiConfigStore` 和现有文件语义 |
| 服务商与模型 | 新增/编辑、模型选择、当前会话与启动默认值、测试请求 | 模型查询、认证与凭据持久化 |
| OAuth | 登录方式、进度、动态问题、错误、退出 | 外部认证流程、回调处理、凭据保存 |
| 技能/MCP/扩展 | 配置、资源状态、社区搜索分页、安装/更新/移除、诊断 | 现有 Node/Pi/npm 与资源重载 |
| 桌面与手势设置面板 | 开关、说明、权限/连接状态、默认桌面及系统设置入口 | RoleManager、Shizuku、无障碍服务与受保护设置 |
| 外观 | 语言/主题/背景选择与预览 | 原生偏好、图片选择、背景文件保存 |
| 聊天内应用选择 | 需要时用 React 展示候选应用 | 复用原生应用列表与显式组件启动 |

“桌面与手势设置”的应用自绘面板也迁移 React；只有动作执行和服务保留原生。系统弹出的授权、图片选择、语音、分享和浏览器界面不属于应用自绘 UI。

Launcher 全部应用抽屉与聊天内应用选择可以使用同一原生应用数据源，不应复制 PackageManager 查询或组件启动逻辑到网页。

## 5. 容器与导航架构

优先采用 **两个 Activity、一个 Android task、一个 Capacitor WebView**：

```text
现有 Android APK
├── MainActivity（原生，保留唯一 HOME/LAUNCHER 入口）
│   └── 首页 / 全部应用 / Launcher 搜索与启动
├── WebAppActivity extends BridgeActivity（新增，不导出）
│   └── React App
│       ├── /chat/:conversationId
│       ├── /history/:conversationId
│       ├── /settings/*
│       └── /settings/editor
├── 本地 Capacitor 插件
│   └── 现有业务与系统能力
└── GestureService / Shizuku / 内嵌 Node runtime
```

路由为设计名称，不是现有实现。Web 页面内部切换 React 路由，不为每个设置页创建 Activity 或 WebView。

`WebAppActivity` 由原生显式 Intent 打开，不声明 HOME/LAUNCHER filter，不建立独立 task affinity，也不使用独立进程。沿用主 task，避免新的启动图标和重复最近任务项。

### 5.1 HOME、Back 与恢复

- 从 Launcher 打开 Web UI：携带目标页面及必要的会话标识。发送动作另带可去重的提交标识，避免 Activity 重建再次发送。
- Home：继续交给原生 HOME 入口。现有 `MainActivity.singleTask` 收到 HOME 后可清除其上的 Activity，因此必须支持 Web 容器被销毁后恢复。
- Back：先关闭键盘，再关闭弹窗/抽屉，再处理编辑器未保存提示，再回退 Web 路由；Web 根页面调用原生关闭容器并回 Launcher。
- 原生首页 Back：保持无动作。
- 路由切换：不等于取消模型生成；聊天、设置之间切换后可恢复当前生成状态。
- 页面重载/重建：重新注册监听，再取得原生快照并合并后续事件；不能依赖旧 WebView 内存。
- 生成期间切换会话：首期保留现有“先停止，再新建/切换”的约束，不在 UI 迁移中额外引入多会话并行执行。

Android 系统返回和网页路由只能有一个协调入口，不能同时让 Capacitor、React Router 和原生回调重复处理。接入阶段验证预测性返回、IME、外部系统页面返回及连续 Home。

### 5.2 主题和窗口

为 Capacitor Activity 配置其需要的 AppCompat 兼容主题，显式保留 Launcher 的主题。Capacitor 8 的 `BridgeActivity` 初始化涉及主题设置，需验证进入 Web UI 后再回 Launcher、旋转或重建不会改变首页样式。

由 React/Tailwind 绘制 Web 背景、文字、滚动区域和动画；按 Capacitor 8 的 System Bars / CSS inset 方案处理状态栏、导航栏与键盘，避免原生 padding 与 CSS 安全区重复累加。遵循系统字体缩放、无障碍和减少动画设置。

## 6. 原生业务拆分与插件

目前 `MainActivity` 同时持有 UI、聊天请求、Pi preview 持久化、epoch、executor 和取消逻辑。新增 WebView 前，应把会话执行与存储编排移出 Activity，形成供 Launcher 和 Capacitor 插件调用的普通 Java 对象，复用现有 `ChatStore`、`PiConfigStore`、`PiAgentBridge` 等实现。

这些对象不持有旧 Activity/View；插件负责调用、Activity 结果和事件订阅。前端离开或插件销毁时解除订阅，不应顺带关闭整个共享 runtime。

首期不新增常驻前台服务，也不承诺 Android 杀进程后继续生成。应用进程仍存活时，Home 导致的 Web UI 销毁不应自动丢掉执行与已保存状态；进程终止后沿用中断记录，在恢复时展示真实状态，不自动重发用户请求。

### 6.1 插件划分

使用应用内 Java 插件，无需先制作独立 npm 插件包。按已有职责分为以下三个入口即可：

| 建议插件 | 职责 |
| --- | --- |
| `ChatPlugin` | 会话/分支读写、发送、取消、快照、模型选择、流式与工具事件 |
| `SettingsPlugin` | 设置/schema、文件/草稿/冲突、资源/扩展、模型/认证操作 |
| `DevicePlugin` | 应用列表与启动、手势/权限状态、系统设置、背景选择、语音和返回 Launcher |

分享等通用能力可按需使用官方 Capacitor 插件；同一能力只保留一个调用入口。插件名称和方法是待实现设计，不代表项目已有这些 API。

Java 端采用 `@CapacitorPlugin`、`@PluginMethod`、`PluginCall.resolve/reject`；TypeScript 端采用 `registerPlugin<T>()`。原生事件用 `notifyListeners()`，前端用 `addListener()`，退出订阅时移除 listener。

选用 Capacitor 后，不再另建 `addJavascriptInterface` 或 `WebViewCompat.addWebMessageListener` 协议，也不并行安装另一套资源拦截器。由 Capacitor 统一管理其 WebView 与资源加载。

### 6.2 消息契约

请求采用 Promise，长任务状态采用事件。`send` 的成功返回表示接受请求，不表示模型已完成；生成完成、取消和错误用明确终态通知。

建议所有会话事件至少携带：

- `conversationId`、`requestId`：所属会话与请求。
- `nodeId`：树节点相关事件使用。
- 单调 `sequence`：识别重复、快照覆盖和遗漏事件。
- `type` 与对应 payload：例如 `textDelta`、`toolUpdate`、`runStatus`、`snapshot`、`error`。

冷启动先订阅、暂存事件，再读取带 sequence 的快照，只应用快照之后的事件；发现序号缺口时重新读取快照。WebView 重载后以原生快照恢复，不把 Capacitor listener 当成持久消息队列。

流式输出合并小片段后推送，初始可按约 30–50 ms 批量更新并测量响应时间；终态立即刷新。不得每个 token 都传输整个历史树。当前 Pi 路径有增量输出，传统 OpenAI 路径当前是非流式，前端需要兼容最终结果一次性返回。

图片/附件用受控文件引用，不在高频事件内反复传大段 Base64。React 仅更新正在生成的消息，避免每次 token 都重渲染所有历史消息和设置页面。

## 7. 存储、配置和凭据

沿用现有原生存储作为业务事实来源，迁移 UI 不迁移数据格式：

| 数据 | 继续使用的位置/实现 |
| --- | --- |
| 会话、索引、草稿、当前会话模型、待完成请求 | `ChatStore` 与 `SharedPreferences("chat")` |
| Pi 节点上下文 | `files/pi-contexts/` |
| 全局 Pi 配置 | `files/node/.pi/agent` |
| 工作区配置 | `files/pi-workspace/.pi` |
| 配置原子更新/上一版/冲突检查 | `PiConfigStore` |
| 外观 | `SharedPreferences("ui")`、`files/appearance/background.png` |
| 设置编辑草稿 | 从 `PiSettingsActivity` 私有 preferences 明确读取/迁移，不能仅删 Activity 后丢弃 |

前端不使用 localStorage 保存 API key、OAuth token、完整配置或会话最终态。用户在 React 中输入新凭据时可以短暂经过表单内存和插件参数，提交后清除；查询配置默认只返回掩码、是否已配置等必要信息，不能把凭据写入日志。

模型选择继续区分“当前会话”与“启动默认值”；配置继续区分全局与工作区；保留未知字段、数字写法、冲突提示、草稿以及上一版恢复。JSON 编辑器不能绕过既有冲突检查直接覆盖文件。

权限、URL、文件标识及操作参数由原生插件在入口校验。只向受信任的打包页面开放插件；外部链接/OAuth 登录在系统浏览器打开，不能把不可信网页导航进拥有完整原生权限的应用 WebView。Markdown 默认禁用原始 HTML。

## 8. 工程布局与 Android 接入

建议保留现有 Android 根工程，在根目录新增前端工具配置，网页源码单独放 `web/`：

```text
项目根目录/
├── app/                         # 现有 Android 模块
├── build.gradle
├── settings.gradle
├── capacitor.config.ts          # 新增
├── package.json                 # 新增：前端与 Capacitor CLI 依赖
├── package-lock.json
├── vite.config.ts               # 新增：Vite root 指向 web
├── web/
│   ├── index.html
│   ├── src/
│   │   ├── app/                 # 路由、主题和应用入口
│   │   ├── features/            # chat / history / settings
│   │   ├── components/          # 通用 UI
│   │   └── native/              # 插件类型与调用入口
│   └── dist/                    # 构建产物，不手工编辑
├── pi-runtime/                  # 保持独立 Node runtime 与 lockfile
└── design/capacitor-migration/
```

建议的 Capacitor 配置如下，仅表示接入目标：

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.launcherprobe',
  appName: 'Launcher Probe',
  webDir: 'web/dist',
  android: {
    path: '.',
  },
};

export default config;
```

Vite 的 `root` 设为 `web`，其输出目录设为 `dist`，使产物落在 `web/dist`。Tailwind 4 使用官方 `@tailwindcss/vite` 插件。`android.path` 指向现有 Android 根工程是 Capacitor 提供的配置能力，但**不会自动把普通 Android 项目转换成 Capacitor 项目**。

首次接入需对照锁定版本的 Capacitor Android 模板，合并 Gradle 模块引用、生成设置文件、app 依赖、资源、主题、Manifest 和插件注册。可以在临时目录生成参考模板；不要在当前仓库执行平台生成命令来替换已有 `app/`。

保留现有应用 ID、debug 签名、服务/Provider、NDK/CMake、`libnode_launcher.so` 打包和 npm asset 忽略规则。Capacitor 的 public/config/plugin 产物与 `pi-runtime` assets 分开管理，同步时不得清理 Node/npm payload。

### 8.1 构建顺序

接入完成后的构建步骤为：

1. 安装根前端依赖并构建 React，输出 `web/dist`。
2. 执行 Capacitor Android 同步，更新网页产物、配置和插件依赖。
3. 按现有脚本准备/构建 `pi-runtime`；与网页构建可以独立，但两者都必须在 APK 打包前完成。
4. 执行现有 Android 测试、APK 构建和 Lint。

未来命令可采用 `npm ci`、`npm run build`、`npx cap sync android`，再执行项目验证入口；这些命令要在配置与 Gradle 集成完成后才成立，当前文档没有执行它们。

开发时用 Vite 提供网页热更新，浏览器中通过开发专用 mock 查看页面；原生能力仍用设备上的 Capacitor 容器验证。开发服务器地址只用于调试，正式 APK 加载本地静态资源，不要求启动桌面 Node 服务或访问 Vite。

## 9. 迁移顺序与完成标准

### 阶段一：验证容器与构建

新增最小 `WebAppActivity` 和 React 页面，完成工具链升级、插件调用/事件往返、资源打包和 HOME/Back 路径。

完成标准：Launcher 正常启动；可进入/退出 Web UI；离线加载页面；Android 构建/Lint 通过；现有 Node/npm payload 和手势服务仍正常。检查 WebView 版本、主题、edge-to-edge、键盘、中文输入、旋转及大字体。

### 阶段二：分离执行状态，迁移聊天与历史

将聊天执行从 `MainActivity` 视图生命周期拆出，接入 `ChatPlugin`，迁移完整聊天、输入区、工具详情、会话抽屉和历史树。

完成标准：发送、流式输出、非流式输出、停止、错误、模型选择、分支续接、草稿和删除行为与原来一致；Home/重建不导致重复发送；迟到事件不污染其他会话。保留首页发送入口的交接行为。

### 阶段三：迁移全部设置和应用自绘弹窗

按设置类别迁移，再补齐高级 JSON 编辑器、扩展社区、OAuth 动态提示、背景与权限控制面板。替换原 Activity result 中模型选择、旧工具模式配置和图片选择的结果传递，但保留其业务语义。

完成标准：全局/工作区、当前模型/默认模型、未知字段、草稿、冲突、上一版、认证、包安装和资源加载反馈完整。由 Web 修改语言、主题或桌面配置后，回 Launcher 可以读取并应用。

### 阶段四：移除旧 UI 并完成回归

删除已替代的原生非 Launcher 页面、`PiSettingsActivity` UI 和相关 Manifest 注册；迁移其私有草稿后再删除对应读取入口。确认没有调用者后清理原生 Markdown 等仅服务旧 UI 的依赖，保留业务类和系统能力。

完成标准：所有非 Launcher 自绘界面由 React 承担；没有重复编辑器或第二套会话存储；覆盖安装保留会话/配置/草稿；APK 包体、冷启动时间、Web UI 首次打开时间、内存和流式更新性能有记录。

## 10. 必须覆盖的验证

- **Launcher 回归**：默认 HOME、从第三方应用回桌面、连续 Home、首页 Back、全部应用搜索/启动、手势和恢复路径。
- **Web 导航**：聊天进入设置再返回、Web 根页面退出、键盘与 Back 顺序、脏编辑器提示、OAuth/系统选择器返回。
- **执行与恢复**：生成时 Home、旋转/主题变化、WebView 重建、停止后的迟到事件、进程中断后的真实状态、首次握手期间事件不丢失。
- **数据兼容**：已有会话树和旧记录、每会话草稿、Pi 上下文、设置草稿、全局/工作区、CAS 冲突及上一版。
- **Android 边界**：权限拒绝、无语音服务、外部链接、输入法中文组合输入、系统字体缩放、TalkBack、API 29 与目标 Android 版本。
- **构建**：前端类型检查/构建、桥接与路由关键行为测试、现有 Java/Robolectric/Node 检查、APK 构建/Lint、assets 完整性。

优先为真实迁移风险留下可运行检查：例如快照与事件竞态导致重复消息、Activity 重建重复提交、设置草稿丢失。设备检查应记录机型、Android/WebView 版本和具体结果，不能用浏览器预览替代。

## 11. 选型依据与未验证项

已核对官方资料：

- [Capacitor Android](https://capacitorjs.com/docs/android)
- [Android 本地自定义代码与插件注册](https://capacitorjs.com/docs/android/custom-code)
- [Android 插件方法、Activity 结果与事件](https://capacitorjs.com/docs/plugins/android)
- [Capacitor 配置：webDir、android.path、调试服务器](https://capacitorjs.com/docs/config)
- [Capacitor 开发与同步流程](https://capacitorjs.com/docs/basics/workflow)
- [Capacitor 8 工具链与 Android 行为变化](https://capacitorjs.com/docs/updating/8-0)
- [Capacitor 8.0.0 Android Gradle 配置](https://github.com/ionic-team/capacitor/blob/8.0.0/android/capacitor/build.gradle)
- [Capacitor 8.0.0 BridgeActivity 源码](https://github.com/ionic-team/capacitor/blob/8.0.0/android/capacitor/src/main/java/com/getcapacitor/BridgeActivity.java)
- [React 官方 Vite 建议](https://react.dev/learn/build-a-react-app-from-scratch)
- [Tailwind CSS Vite 集成](https://tailwindcss.com/docs/installation/using-vite)
- [Tailwind CSS 浏览器要求](https://tailwindcss.com/docs/compatibility)

两 Activity 的混合结构是基于 Android 导航和 Capacitor 官方 Activity/插件机制作出的项目设计；现有工程需要手动接入与验证，不是已完成的兼容性认证。当前实施进度与已验证范围见 [实施记录](IMPLEMENTATION.md)，不能把本方案中的完成标准视为全部已通过。
