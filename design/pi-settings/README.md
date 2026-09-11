# E Launcher：Pi 设置移动端设计

## 依据与范围

本次只做设计，不修改应用。参考 quntion/pi-desktop 源码（应用 0.1.0、SDK 0.84.0），对照本机 Pi 0.85.1 文档与 E Launcher 0.85.1 依赖。抓取缓存目录名不是 Git 提交号。所有效果图为目标设计，不代表 Android 已具备完整 SDK 能力。

- [桌面逐项控件清单](source/desktop-inventory.md)
- [Pi 字段、模型兼容参数、凭据和环境变量完整清单](source/pi-doc-inventory.md)
- [Android 设置规范](https://developer.android.com/design/ui/mobile/guides/patterns/settings)
- [Android 布局导航](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns)
- [Android 无障碍](https://developer.android.com/guide/topics/ui/accessibility/apps)

## 本次设计裁决（优先于源调查建议）

1. 保留桌面的通用、外观、服务商、技能、MCP、扩展、关于七分类和顺序，末尾增加高级配置。手机使用单栏列表进入全屏子页，不使用七个横向标签或桌面侧栏。
2. 本应用外观的浅色/深色/系统主题不是 Pi `theme` 字段。Pi 终端主题必须额外列入高级 → 终端与渲染。权限门控也不是 `defaultProjectTrust`，分别保留。
3. 当前会话模型与思考快捷选择仍在聊天输入区；Pi 启动默认值在高级配置。两者不是同一存储项。
4. MCP 保留来源分类但显示“通过扩展接入”；不画成原生服务器管理器。桌面源代码中的“SDK 暂不支持”占位不能解释为整个 Pi 生态没有 MCP。
5. 桌面新增 Provider 协议选择提供 10 个 API 类型；Pi 0.85.1 models 文档对 JSON 配置声明的集合较小。保留完整选项清单，非当前运行时支持的类型显示说明/不可选，不把桌面枚举当作 Android 兼容保证。
6. 扩展配置是开放集合。通用 JSON/YAML/文本编辑与文件导入覆盖扩展自定义文件；不虚构统一扩展 schema。所有已文档化核心字段必须有明确分类。
7. 运行操作（发送、fork、compact、CLI mode 等）不伪装成 settings.json 字段；放对应会话操作或高级运行参数说明。

## 视觉和交互

采用现有 E Launcher 色板：象牙底 #F6F5F0、炭黑 #202521、强调绿 #267A69、辅助字 #656D69。白色分组容器、轻分隔线、少量圆角，不做大阴影、渐变营销卡片和桌面缩略界面。

设计基准为紧凑宽度 Android 手机，内容横向内边距 16 dp、顶部返回栏、标题 24 sp、设置主行 16 sp、辅助说明 14 sp、触控目标至少 48×48 dp，保留系统状态栏和底部手势安全区。正文支持字体放大，长表单单一纵向滚动；键盘出现时底部保存动作可见。图片选择调用系统选择器。二级页无需重复底部导航。

直接偏好（语言/外观）即时应用并反馈失败。多字段表单使用明确“保存”；高级页显示作用域、来源和生效时间。模型能力不支持的档位不允许静默回退。删除/卸载使用 Android 确认对话框，不采用 hover 或 3 秒二次点击。示例数据仅用于设计。

## 设计板与完整页面映射

### 01 常规：入口、通用、外观、关于

四个手机画面：设置总览（七类 + 高级）；通用（中文/English、权限门控与规则文件说明）；外观（浅/深/系统、背景预览、更换/清除、20–100% 遮罩）；关于（应用名/版本、基于 Pi、检查更新、源码反馈）。更新检查/可下载/下载进度/安装/失败状态在源清单中逐项保留。

### 02 常规：服务商与会话快捷选择

四个画面：服务商列表（状态、模型数、凭据来源、刷新、测试、更新 Key、自定义新增）；新增服务商全屏表单（ID、显示名、baseUrl、API 协议、Key、多行模型 ID）；服务商凭据详情（遮蔽 Key、保存、测试结果、移除凭据或删除自定义项）；聊天模型/思考底部选择（按服务商选择模型、七档强度、只作用于当前会话的范围提示）。

协议选项完整集合：openai-completions / openai-responses / anthropic-messages / google-generative-ai / google-vertex / azure-openai-responses / mistral-conversations / bedrock-converse-stream / openai-codex-responses / pi-messages。前三字段和模型不能为空；协议支持以实际运行时为准。只允许删除可管理的已存凭据，不能删除进程环境变量来源。

### 03 常规：技能、MCP、扩展

四个画面：技能（当前工作区、名称/描述/路径/作用域、仅手动触发、加载诊断）；MCP（扩展接入说明、前往扩展的移动端导航，不伪造服务器表单）；扩展社区（搜索、全部/扩展/技能/提示词/主题、作者/下载数/安装态、加载更多）；已加载扩展（作用域、隐藏状态、工具/命令/flags/快捷键计数、路径、卸载、加载失败）。技能页面本身仍只读。无活跃会话、加载中、空列表、网络失败、安装/卸载失败均须实现，详见源清单。

### 04 高级：总览、模型默认值、模型定义、兼容性

四个画面：高级目录；模型与思考；自定义模型专家页；协议兼容分组页。完整字段映射：

- 模型与思考：`defaultProvider/defaultModel/defaultThinkingLevel/modelThinkingLevels/thinkingBudgets/enabledModels`。`hideThinkingBlock` 放渲染，`showCacheMissNotices` 放诊断。
- Provider 专家：`headers/authHeader/apiKey/oauth/compat/modelOverrides`；基础 ID/baseUrl/api/key 等链接常规服务商页。
- 模型定义：`id/name/api/reasoning/thinkingLevelMap/input/contextWindow/maxTokens/samplingParams/cost`，以及 cost 的 `input/output/cacheRead/cacheWrite/tiers[].inputTokensAbove` 与各 tier 费率。
- 覆盖内置模型：文档列出的全部 modelOverrides 字段，包括专属 headers。
- OpenAI、Anthropic compat 全字段使用分组子页，完整列表见源清单“compat 全字段”。路由对象、采样参数、chatTemplateKwargs/Args 用键值/JSON 编辑，不截断开放字段。`thinkingFormat` 文档内部枚举不一致，使用建议值 + 自定义输入。

### 05 高级：上下文、请求、工具、网络

四个画面：上下文与会话；请求与消息；工具与 Shell；网络与连接。

- 上下文：`sessionDir/compaction.enabled/reserveTokens/keepRecentTokens/branchSummary.reserveTokens/skipPrompt`。树筛选和双 Escape 行为放终端兼容。
- 请求：`retry.enabled/maxRetries/baseDelayMs/retry.provider.timeoutMs/maxRetries/maxRetryDelayMs/steeringMode/followUpMode`。
- 工具：`defaultTools/shellPath/shellCommandPrefix/npmCommand`。空数组与继承是不同状态。
- 网络：`httpProxy/transport/httpIdleTimeoutMs/websocketConnectTimeoutMs`。httpProxy 标注仅全局。云服务商环境配置链接 06。

### 06 高级：资源、作用域、运行环境、文件

四个画面：资源与包；作用域与信任；环境与凭据；完整配置编辑器。

- 资源：`packages` 所有 source/filter/autoload 项，`extensions/skills/prompts/themes/enableSkillCommands`。支持 npm/git/本地来源，版本及筛选由高级页负责；安装能力需 Android 验证。
- 作用域：全局/工作区、继承来源、`defaultProjectTrust`；信任状态不同于工具权限门控。
- 环境：Pi 配置目录、会话目录、包目录、离线、检查更新、遥测、缓存、分享 URL、终端环境、代理、编辑器等全部文档变量；云厂商 Azure/Bedrock/Vertex/Cloudflare 的凭据和变量按厂商进入详情。完整变量名见源清单，支持自定义键值。
- 凭据：`auth.json` API key 与 provider-scoped `env`、OAuth 登录/更新信息；秘密默认遮蔽。环境/命令引用可配置。只读 Pi 注入变量单列“运行信息”，不可当普通设置。
- 文件：settings/models/auth（专用凭据入口）/SYSTEM.md/APPEND_SYSTEM.md/AGENTS.md/permissions.json/keybindings.json/扩展任意配置文件；新建、导入、导出、语法错误、恢复上一版。keybindings.json 属于终端兼容，权限文件是桌面门控适配，不是 Pi 核心 schema。此处保留所有未表单化配置。
- 运行选项：明确区分进程启动参数与持久 Pi 配置，SDK 集成不假装通过传 CLI 字符串自动支持所有模式。

### 07 高级：隐私、渲染、终端、全屏

四个画面：隐私与诊断；内容渲染；终端兼容；全屏与输入。

- 隐私：`enableInstallTelemetry/enableAnalytics/trackingId/warnings.anthropicExtraUsage/showCacheMissNotices`；更新开关来源为进程环境，链接 06，不造 JSON 字段。
- 渲染：`hideThinkingBlock/images.autoResize/images.blockImages/markdown.codeBlockIndent/markdown.mermaid`，按运行时注明原生消费者，不能承诺 Android 自动采用 TUI 选项。
- 终端：`theme/externalEditor/quietStartup/collapseChangelog/terminal.showImages/imageWidthCells/clearOnShrink/hyperlinks/images/trueColor`。
- 全屏与输入：`editorPaddingX/outputPad/autocompleteMaxVisible/showHardwareCursor/tuiMode/fullscreenExitOutput/fullscreenScrollbar/fullscreenCopyOnSelect/doubleEscapeAction/treeFilterMode`，键位编辑入口。

### 08 补充：选择器与保存状态

四个画面：聊天模型选择器（已配置服务商分组）；10 项 API 协议选择器（可用状态是设计示例，不能当作 Android 实测结果）；单包资源过滤（scope/version/autoload/四类资源与规则）；配置语法错误和保存生效状态。`autoload` 是单包属性，06 总览入口应导航到这里，不能写成全局顶层 `autoload`。

## 图片索引

- [01 入口、通用、外观、关于](images/01-basic-overview.png)
- [02 服务商、表单、凭据、思考选择](images/02-providers-chat.png)
- [03 技能、MCP、社区、已加载扩展](images/03-skills-mcp-extensions.png)
- [04 高级总览、模型默认、模型定义、兼容性](images/04-advanced-models.png)
- [05 上下文、请求、工具、网络](images/05-advanced-runtime.png)
- [06 资源、作用域、环境、编辑器](images/06-advanced-resources-files.png)
- [07 隐私、内容渲染、终端、全屏](images/07-advanced-privacy-terminal.png)
- [08 模型选择、协议列表、包过滤、错误状态（修正版）](images/08-selection-and-states-corrected.png)

已逐张打开检查 8 张最终设计板；08 初稿的错误 JSON 示例使用了非 Pi 设置字段，已针对代码块重新生成修正版，交付目录仅保留修正版。

## 覆盖验收与图稿边界

七个桌面分类都有设计画面；新增服务商全部字段、社区分页、技能诊断、MCP 非原生边界都有明确位置。高级目录覆盖模型、会话、请求、工具、网络、资源、信任、环境/凭据、文件、隐私、渲染、终端。

效果图显示每页首屏和分组入口，不将所有 compat 或环境变量画成不可读的微缩文本。**全量字段以两个源清单及本文件的纠正/映射为准**。图片生成可能产生文字误差，不能以图片替代实现规范。图片出现的安装、登录、工具和热加载是目标交互，仍需后续 Android SDK 兼容实现与测试。
