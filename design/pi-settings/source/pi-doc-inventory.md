# Code Context

## Files Retrieved

1. `D:/software/nvm/v24.14.0/node_modules/@earendil-works/pi-coding-agent/package.json`（全文件，约 lines 1-75）— 文档对应包名与版本；本机文档包为 `@earendil-works/pi-coding-agent` **0.85.1**。
2. `.../docs/settings.md`（全文，lines 1-约 300）— `settings.json` 的权威逐项字段表、作用域、合并和 project trust 规则。
3. `.../docs/models.md`（全文，lines 1-约 430）— `models.json` provider/model/modelOverrides/compat 的权威字段表。
4. `.../docs/providers.md`（全文，lines 1-约 260）— 内置凭据、`auth.json`、云 provider 环境变量与凭据解析顺序。
5. `.../docs/environment-variables.md`（全文，lines 1-约 95）— Pi 进程配置变量、进程标记、shell 会话注入变量。
6. `.../docs/packages.md`（全文，lines 1-约 220）— package source、过滤对象、全局/项目作用域及 CLI 管理边界。
7. `.../docs/skills.md`（全文，lines 1-约 180）— skill 路径、发现规则、唯一持久设置 `skills`/`enableSkillCommands` 与 CLI 临时加载边界。
8. `.../docs/prompt-templates.md`（全文，lines 1-约 90）— prompt 路径及 CLI 临时加载边界。
9. `.../docs/custom-provider.md`（全文，lines 1-约 500）— 扩展注册 provider 与动态/任意扩展配置的边界；扩展代码配置不是固定 settings schema。
10. `.../docs/extensions.md`（相关部分 lines 1-约 230、ExtensionContext 配置部分约 600-760；文件共 3024 行）— 扩展可注册任意 flag/UI/工具并自行读取项目 JSON；不存在可枚举的统一扩展配置 schema。
11. `.../docs/usage.md`（全文，lines 1-约 330）— CLI flags、slash commands、TUI 行为；用于避免把运行操作误列为持久设置。

> 行号为安装包 Markdown 的当前布局范围；实施时应以该绝对路径下的 0.85.1 文件为准。

## Key Code

## 版本结论与边界

- 文档根的 `package.json.version` 是 **0.85.1**，用户给出的 desktop 内嵌 app pi 也是 **0.85.1**：当前没有版本号差异，应按同版实现。
- “文档版本”和“app pi 版本”仍应在高级页显示为两个来源：`Docs: 0.85.1 / Runtime: 0.85.1`。即使此刻相同，也**不能保证升级后跨版本字段可用**；保存前应按 runtime version/schema 做兼容提示，未知字段优先保留，不要 destructive rewrite。
- 两层设置：全局 `~/.pi/agent/settings.json`；项目 `.pi/settings.json`。项目覆盖全局，嵌套对象递归 merge；但 `defaultTools` 等数组由项目数组整体替换。`defaultProjectTrust`、`httpProxy` 仅全局。
- project settings/resources/extensions 受 trust 控制。非交互模式下 `ask` 与 `never` 都忽略未信任项目资源；`always` 才加载。

## `settings.json` 完整 key 清单及高级页面映射

以下逐项覆盖 `docs/settings.md` 的每个 key，包含嵌套 key。括号内为类型、默认值/约束。已知 desktop 已暴露的语言、权限门控、主题/背景不应重复；其中只有 `theme` 是 Pi 原生字段，语言/背景/权限门控大概率是 desktop 自身或扩展配置。

### A. 模型与推理

- `defaultProvider` — string，无默认；启动 provider。
- `defaultModel` — string，无默认；启动 model id。
- `defaultThinkingLevel` — enum string：`off|minimal|low|medium|high|xhigh|max`。
- `modelThinkingLevels` — object；动态键为 `provider/modelId`，值为上述 thinking level。
- `hideThinkingBlock` — boolean，默认 `false`。
- `showCacheMissNotices` — boolean，默认 `false`；缓存 miss、compaction/branch summary 与 provider recovery 诊断通知。
- `thinkingBudgets` — object；动态键至少为 thinking levels，值为 token number。文档例示 `minimal|low|medium|high`，语义上是按 level 的自定义 budget；UI 用键值表，不硬编码只允许四项。

### B. 会话与上下文

- `sessionDir` — string；绝对/相对/`~`，优先级低于 `PI_CODING_AGENT_SESSION_DIR` 和 `--session-dir`。
- `compaction.enabled` — boolean，默认 `true`。
- `compaction.reserveTokens` — number，默认 `16384`。
- `compaction.keepRecentTokens` — number，默认 `20000`。
- `branchSummary.reserveTokens` — number，默认 `16384`；输出仍 cap 4096。
- `branchSummary.skipPrompt` — boolean，默认 `false`。
- `treeFilterMode` — enum `default|no-tools|user-only|labeled-only|all`，默认 `default`（TUI `/tree` 默认过滤）。
- `doubleEscapeAction` — enum `tree|fork|none`，默认 `tree`（TUI-only 交互）。

### C. 请求、重试与消息投递

- `retry.enabled` — boolean，默认 `true`。
- `retry.maxRetries` — number，默认 `3`。
- `retry.baseDelayMs` — number，默认 `2000`。
- `retry.provider.timeoutMs` — number，默认 SDK default。
- `retry.provider.maxRetries` — number，默认 `0`；文档建议保持 0，避免 provider SDK 吞掉超额错误并长时间阻塞。
- `retry.provider.maxRetryDelayMs` — number，默认 `60000`；`0` 表示不限制服务端要求的等待。
- `steeringMode` — enum `all|one-at-a-time`，默认 `one-at-a-time`。
- `followUpMode` — enum `all|one-at-a-time`，默认 `one-at-a-time`。
- `transport` — enum `sse|websocket|websocket-cached|auto`，默认 `auto`。
- `httpIdleTimeoutMs` — number，默认 `300000`，`0` 禁用。
- `websocketConnectTimeoutMs` — number，默认 `15000`，`0` 禁用。

### D. 工具与 Shell

- `defaultTools` — string[]；内置可选 `read,bash,powershell,edit,write,grep,find,ls`。省略使用标准默认，`[]` 禁用内置但不禁用 extension/SDK tools；项目数组替换全局数组。
- `shellPath` — string；支持 `~`，Windows JSON 路径需 `/` 或转义 `\\`。
- `shellCommandPrefix` — string；每个 bash 命令前缀。
- `npmCommand` — string[] argv；影响全部 npm lookup/install/uninstall 和 git 包依赖安装。

### E. 网络、隐私、警告

- `httpProxy` — string URL；仅全局，同时作为 `HTTP_PROXY`/`HTTPS_PROXY`。
- `enableInstallTelemetry` — boolean，默认 `true`；匿名安装/升级 ping **以及** OpenRouter/NVIDIA/Cloudflare attribution headers，不控制版本检查。
- `enableAnalytics` — boolean，默认 `false`；实验首次设置才询问。
- `trackingId` — string；开启 analytics 时生成。应只读展示或谨慎编辑，不应提供“生成新 ID”花活。
- `warnings.anthropicExtraUsage` — boolean，默认 `true`。
- `showCacheMissNotices`（也可在诊断组呈现，字段只存一次）。

### F. 终端与外观（主要 TUI-only）

- `theme` — string，默认 `dark`；**已在 appearance 暴露**，高级页只做跳转/不重复。
- `externalEditor` — string；覆盖 `VISUAL`、`EDITOR`，再 fallback Windows Notepad / 其他平台 nano。
- `quietStartup` — boolean，默认 `false`。
- `collapseChangelog` — boolean，默认 `false`。
- `editorPaddingX` — number，0–3，默认 0。
- `outputPad` — number，0 或 1，默认 1。
- `autocompleteMaxVisible` — number，3–20，默认 5。
- `showHardwareCursor` — boolean，默认 `false`。
- `tuiMode` — enum `regular|fullscreen`，默认 `regular`；`--tui-mode` 单次覆盖。
- `fullscreenExitOutput` — enum `transcript|resume-hint`，默认 `transcript`；regular 无效。
- `fullscreenScrollbar` — enum `auto|always|hidden`，默认 `auto`；regular 无效。
- `fullscreenCopyOnSelect` — boolean，默认 `true`；fullscreen 专用。
- `terminal.showImages` — boolean，默认 `true`。
- `terminal.imageWidthCells` — number，默认 `60`。
- `terminal.clearOnShrink` — boolean，默认 `false`。
- `terminal.hyperlinks` — boolean 或 `auto`，默认 `auto`；JSON-only advanced。
- `terminal.images` — `kitty|iterm2|auto|false`，默认 `auto`；JSON-only advanced。
- `terminal.trueColor` — boolean 或 `auto`，默认 `auto`；JSON-only advanced。
- `images.autoResize` — boolean，默认 `true`；2000×2000 max。
- `images.blockImages` — boolean，默认 `false`；禁止图片发给 LLM。

### G. Markdown

- `markdown.codeBlockIndent` — string，默认两个空格。
- `markdown.mermaid` — enum `off|final|streaming`，默认 `streaming`。

### H. 模型轮换

- `enabledModels` — string[]；与 CLI `--models` pattern 格式相同，用于 Ctrl+P scope；支持模型匹配及文档其他处示例的 `provider/*:high` thinking pin。不是 provider catalog 编辑。

### I. 资源与包

- `packages` — array，默认 `[]`：
  - string entry：package source，加载全部资源。
  - object entry：
    - `source` — string。
    - `extensions` — string[] filter。
    - `skills` — string[] filter。
    - `prompts` — string[] filter。
    - `themes` — string[] filter。
    - `autoload` — packages 文档在 scope/dedup 规则中明确使用 `false` 作为 project 对 global 的 delta（虽 settings 主表未单列，编辑器必须保留/支持）。
  - filter 语法：`!pattern` 排除；`+path` 强制包含精确路径；`-path` 强制排除精确路径；省略类型=全部，`[]`=一个也不加载。
- `extensions` — string[]，默认 `[]`；本地 extension 文件/目录/glob。
- `skills` — string[]，默认 `[]`；本地 skill 文件/目录/glob。
- `prompts` — string[]，默认 `[]`；本地 prompt template 文件/目录/glob。
- `themes` — string[]，默认 `[]`；本地 theme 文件/目录/glob。
- `enableSkillCommands` — boolean，默认 `true`。

资源数组路径相对各自 settings 文件目录解析，支持绝对路径和 `~`。desktop 已有 npm 安装卸载、skills 只读、extensions 分类，但高级页仍需提供精确 package filter 和 local paths，否则不能完整覆盖。

### J. 信任

- `defaultProjectTrust` — enum `ask|always|never`，默认 `ask`，**仅全局**。已知 desktop 权限门控若已覆盖它，应绑定同一原生 key；不要把 desktop 自身 permission policy 误写到 Pi settings。

## `models.json` 完整字段

文件：`~/.pi/agent/models.json`，顶层：

- `providers` — object，动态 key 即 provider id。

每个 `providers.<id>`：

- `baseUrl` — endpoint string。
- `api` — `openai-completions|openai-responses|anthropic-messages|google-generative-ai`（`models.md` 对 JSON 声明的支持集合）。扩展 API 另支持更多类型，不应在普通 JSON UI 无依据开放。
- `apiKey` — optional string；literal、`$ENV_VAR`/`${...}`、整值 `!command`，`$$`/`$!` escape。
- `oauth` — 当前 JSON 动态 OAuth provider type 仅 `radius`，并要求 gateway `baseUrl`。
- `headers` — object<string,string>；值同样支持 literal/env/command resolution。
- `authHeader` — boolean；自动 Bearer。
- `compat` — provider 级 compat defaults，见下方全表。
- `models` — model config array。
- `modelOverrides` — object，以已有 model id 为动态键；未知 id 忽略。

每个 `models[]`：

- `id`（required string）
- `name`（string，默认 id）
- `api`（可覆盖 provider api）
- `reasoning`（boolean，默认 false）
- `thinkingLevelMap`（object；key 为 `off|minimal|low|medium|high|xhigh|max`，值 string 或 `null`；null 表示不支持；旧 `compat.reasoningEffortMap` 应迁移到这里）
- `input`（`["text"]` 或 `["text","image"]`，默认前者）
- `contextWindow`（number，默认 128000）
- `maxTokens`（number，默认 16384）
- `samplingParams`（free-form object；仅 OpenAI-compatible API 使用，逐键原样覆盖 Pi request body；modelOverrides 中逐键 merge）
- `cost.input`、`cost.output`、`cost.cacheRead`、`cost.cacheWrite`（number，$/million，默认均 0）
- `cost.tiers[]`：`inputTokensAbove`、`input`、`output`、`cacheRead`、`cacheWrite`；匹配最高 threshold，完整替代该次请求 rate set。
- `compat`（model 级，merge/覆盖 provider compat）

`modelOverrides.<modelId>` 支持且只支持：

- `name`
- `reasoning`
- `thinkingLevelMap`
- `input`
- `cost`（partial）
- `contextWindow`
- `maxTokens`
- `samplingParams`（逐 key merge）
- `headers`
- `compat`

### compat 全字段（provider 级及 model 级）

OpenAI-compatible：

- `supportsStore` — boolean
- `supportsDeveloperRole` — boolean
- `supportsReasoningEffort` — boolean
- `supportsUsageInStreaming` — boolean，默认 true
- `supportsFinishReason` — boolean，默认 true
- `maxTokensField` — `max_completion_tokens|max_tokens`
- `requiresToolResultName` — boolean
- `requiresAssistantAfterToolResult` — boolean
- `requiresThinkingAsText` — boolean
- `requiresReasoningContentOnAssistantMessages` — boolean
- `thinkingFormat` — 文档主表：`reasoning_effort|openrouter|deepseek|together|baseten|zai|qwen|chat-template|qwen-chat-template`。同版 `custom-provider.md` 类型参考还列出 `openai|string-thinking|ant-ling`；这是同版文档内部差异，UI 应以自由输入+建议值呈现，而非封死 enum。
- `chatTemplateKwargs` — free-form object；值可为 primitive/null 或 `{ "$var": "thinking.enabled|thinking.effort|thinking.budget", "omitWhenOff"?: boolean }`。
- `chatTemplateArgs` — 同上。
- `thinkingTokenBudgetField` — `thinking_token_budget|thinking_budget|thinking_budget_tokens`。
- `supportsThinkingTokenBudget` — boolean；前者为 vLLM `thinking_token_budget` 的 alias，优先用前者。
- `cacheControlFormat` — 当前仅 `anthropic`。
- `sendSessionAffinityHeaders` — boolean（OpenAI completions；Anthropic 也有同名字段）。
- `sessionAffinityFormat` — `openai|openai-nosession|openrouter`。
- `supportsStrictMode` — boolean。
- `supportsOpenAIGrammarTools` — boolean，默认 false。
- `deferredToolsMode` — 当前仅 `kimi`（models.md 主表有，custom-provider 类型片段遗漏；必须保留）。
- `supportsLongCacheRetention` — boolean，默认 true。
- `openRouterRouting` — **free-form object sent as-is**；示例含 `allow_fallbacks,require_parameters,data_collection,zdr,enforce_distillable_text,order,only,ignore,quantizations,sort.by,sort.partition,max_price.prompt,max_price.completion,preferred_min_throughput.p50,p90,preferred_max_latency.p50,p90,p99`，但上游 OpenRouter 可扩展，因此只能 JSON object editor。
- `vercelGatewayRouting` — object，已文档化 `only`、`order` string[]。

Anthropic Messages：

- `supportsEagerToolInputStreaming` — boolean，默认 true。
- `supportsLongCacheRetention` — boolean，默认 true。
- `sendSessionAffinityHeaders` — boolean/自动探测语义。
- `supportsCacheControlOnTools` — boolean，默认 true。
- `forceAdaptiveThinking` — boolean，默认 false。
- `supportsMidConvoEffort` — boolean，默认 false（`models.md` 有；custom-provider 类型片段遗漏，不能漏）。
- `allowEmptySignature` — boolean，默认 false。
- `supportsStrictTools` — boolean，custom 默认 false。

重要模型语义：内置 provider 只设置 `baseUrl`/headers 可保留内置 models；`models` 与内置 catalog 按 id upsert，新 id 添加、相同 id 替换。`modelOverrides` 先应用，custom `models` 后 merge，同 id custom 最终替换。`models.json` 每次打开 `/model` reload，无需重启。

## 凭据：不要混入普通 settings

### `auth.json`

路径 `~/.pi/agent/auth.json`，API key entry：

```json
{ "provider-id": { "type": "api_key", "key": "...", "env": { "NAME": "value" } } }
```

- `key` 支持 literal/env interpolation/`!command`；auth command 在 process lifetime 缓存。
- `env` 是 provider-scoped 环境值，优先于进程环境，用于 key/header/provider config（Cloudflare/Azure/Vertex/Bedrock/cache retention/proxy 等）。
- OAuth entry 由 `/login` 管理，包含 access/refresh/expiry，不应当作普通可编辑设置表单；敏感字段默认遮罩。
- 凭据解析顺序：CLI `--api-key` > `auth.json` > process env > `models.json.apiKey`。

### 内置 provider key 对照（完整）

- `anthropic`: `ANTHROPIC_API_KEY`
- `ant-ling`: `ANT_LING_API_KEY`
- `azure-openai-responses`: `AZURE_OPENAI_API_KEY`
- `openai`: `OPENAI_API_KEY`
- `deepseek`: `DEEPSEEK_API_KEY`
- `nvidia`: `NVIDIA_API_KEY`
- `google`: `GEMINI_API_KEY`
- `amazon-bedrock`: `AWS_BEARER_TOKEN_BEDROCK`
- `mistral`: `MISTRAL_API_KEY`
- `groq`: `GROQ_API_KEY`
- `cerebras`: `CEREBRAS_API_KEY`
- `cloudflare-ai-gateway`: `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID`
- `cloudflare-workers-ai`: `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`
- `xai`: `XAI_API_KEY`
- `openrouter`: `OPENROUTER_API_KEY`
- `vercel-ai-gateway`: `AI_GATEWAY_API_KEY`
- `zai`: `ZAI_API_KEY`
- `zai-coding-cn`: `ZAI_CODING_CN_API_KEY`
- `opencode`, `opencode-go`: `OPENCODE_API_KEY`
- `radius`: `RADIUS_API_KEY`
- `huggingface`: `HF_TOKEN`
- `fireworks`: `FIREWORKS_API_KEY`
- `together`: `TOGETHER_API_KEY`
- `baseten`: `BASETEN_API_KEY`
- `kimi-coding`: `KIMI_API_KEY`
- `minimax`: `MINIMAX_API_KEY`
- `minimax-cn`: `MINIMAX_CN_API_KEY`
- `qwen-token-plan`, `qwen-token-plan-individual`: `QWEN_TOKEN_PLAN_API_KEY`
- `qwen-token-plan-cn`: `QWEN_TOKEN_PLAN_CN_API_KEY`
- `xiaomi`: `XIAOMI_API_KEY`
- `xiaomi-token-plan-cn`: `XIAOMI_TOKEN_PLAN_CN_API_KEY`
- `xiaomi-token-plan-ams`: `XIAOMI_TOKEN_PLAN_AMS_API_KEY`
- `xiaomi-token-plan-sgp`: `XIAOMI_TOKEN_PLAN_SGP_API_KEY`

OAuth `/login` provider：ChatGPT/Codex、Claude Pro/Max、GitHub Copilot、xAI subscription、OpenRouter、Radius。它们是凭据动作，不是 settings key。

## 环境变量与云 provider 配置（高级页应独立“运行环境”，不能写进 settings JSON）

Pi process config：

- `PI_CODING_AGENT_DIR`
- `PI_CODING_AGENT_SESSION_DIR`
- `PI_PACKAGE_DIR`
- `PI_OFFLINE`
- `PI_SKIP_VERSION_CHECK`
- `PI_TELEMETRY`
- `PI_CACHE_RETENTION`（`long`）
- `PI_SHARE_VIEWER_URL`
- `PI_HARDWARE_CURSOR`
- `PI_HYPERLINKS`
- `PI_IMAGE_PROTOCOL`
- `PI_TRUE_COLOR`
- `PI_TUI_ESC_TIMEOUT`
- `VISUAL`, `EDITOR`
- `HTTP_PROXY`, `HTTPS_PROXY`

云 provider 非凭据配置：

- Azure：`AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`；可选 `AZURE_OPENAI_API_VERSION`、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。
- Bedrock：`AWS_PROFILE`；或 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`；region `AWS_REGION`；ECS `AWS_CONTAINER_CREDENTIALS_*`；IRSA `AWS_WEB_IDENTITY_TOKEN_FILE`；`AWS_BEDROCK_FORCE_CACHE`；proxy `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`、`AWS_BEDROCK_SKIP_AUTH`、`AWS_BEDROCK_FORCE_HTTP1`。
- Vertex：`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`GOOGLE_APPLICATION_CREDENTIALS`。
- Git 非交互 package：`GIT_TERMINAL_PROMPT`、`GIT_SSH_COMMAND`（package 操作环境，不是 Pi settings）。

只读/诊断变量，不是用户配置：

- Pi 设置的 process markers：`AI_AGENT=pi`、`PI_CODING_AGENT=true`。
- shell tool 注入：`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。
- `PI_SERVER_DIR`、`PI_SERVER_ID` 仅 source-only experimental remote harness，不适用于 distributed build，别画到常规高级页。

## CLI/运行选项与 TUI-only：不要冒充持久设置

### 有持久 settings 对应、但 CLI 仅单次覆盖

- `--provider`, `--model`, `--thinking` ↔ defaults（但 flag 是本次运行）。
- `--models` ↔ `enabledModels`。
- `--session-dir` ↔ `sessionDir`，且 flag 优先。
- `--tui-mode` ↔ `tuiMode`。
- `--use-theme` / resource `--theme <path>` 分别是单次选用主题/单次加载主题，不等于持久 `theme`/`themes`。
- `--api-key` 是本次凭据覆盖，不是设置。

### 纯运行/操作项（不要写成 settings 字段）

- modes：`-p/--print`、`--mode json`、`--mode rpc`、`--export`。
- sessions：`-c/--continue`、`-r/--resume`、`--session`、`--fork`、`--no-session`、`--name`。
- tools：`--tools`、`--exclude-tools`、`--no-builtin-tools`、`--no-tools`。
- resources：`-e/--extension`、`--no-extensions`、`--skill`、`--no-skills`、`--prompt-template`、`--no-prompt-templates`、`--theme`、`--no-themes`、`--no-context-files`。
- prompts/trust：`--system-prompt`、`--append-system-prompt`、`--approve`、`--no-approve`。
- misc：`--verbose`、`--help`、`--version`、`--`。
- package commands：`pi install/remove/uninstall/list/update/config` 是管理动作；虽然 install/remove 会修改 `packages`，仍不是 settings key。desktop 已有 npm 包安装卸载可复用。
- slash/TUI commands 如 `/login`, `/logout`, `/model`, `/thinking`, `/settings`, `/trust`, `/tree`, `/compact`, `/reload` 等是操作，不是字段。

TUI-only/主要只影响 TUI 的原生 settings：`doubleEscapeAction`, `treeFilterMode`, `editorPaddingX`, `outputPad`, `autocompleteMaxVisible`, `showHardwareCursor`, `tuiMode`, `fullscreenExitOutput`, `fullscreenScrollbar`, `fullscreenCopyOnSelect`, `quietStartup`, `collapseChangelog`, `externalEditor`, `terminal.*`, `markdown.mermaid` 的终端呈现。Desktop 若不嵌 TUI，可放入“终端兼容（仅 pi CLI 生效）”折叠区，而不是假装影响 desktop UI。

## 扩展任意配置的硬边界

Pi 核心仅能枚举：`packages`、`extensions`、`skills`、`prompts`、`themes` 及加载过滤。扩展本身可以：

- 注册任意 CLI flag、command、shortcut、tool、UI；
- 通过 `CONFIG_DIR_NAME` 自行读取如 `.pi/my-extension.json`；
- 动态注册 provider/model；
- 用任意自定义文件格式和 schema。

因此不存在“所有扩展配置”的有限字段清单。**通用完整覆盖只能提供文件浏览/原始 JSON/YAML/文本编辑器**（全局与项目目录、明确 trust 与任意代码风险），或者由扩展未来主动提供 schema。不要为未知扩展猜表单。MCP 也不是 Pi 核心设置：文档明确 Pi 不内置 MCP；desktop 的 MCP 占位属于 desktop/extension 层。

## Architecture

建议只画 7 个有限高级分组，避免几十个一级 tab：

1. **模型与推理**：A + H；链接到现有 Providers；另设“models.json 专家编辑器”。
2. **上下文与会话**：B。
3. **请求与消息**：C。
4. **工具、Shell 与网络**：D + `httpProxy`；敏感 shell prefix 明示风险。
5. **隐私、诊断与更新**：E。
6. **终端与渲染（pi CLI/TUI）**：F + G，默认折叠；主题跳转现有 appearance。
7. **资源、作用域与高级文件**：I + J；global/project toggle；packages/local resource filters；`settings.json`、`models.json`、`auth.json`（凭据专用 UI，非普通文本默认展示）、环境变量说明、extension arbitrary config 文件编辑入口。

字段数据流：

- desktop 表单写 `settings.json`；global/project 分开加载，project nested merge global，写入时只改目标 key 并保留未知字段。
- provider catalog 表单写 `models.json`；现有 providers 页面已覆盖 id/name/baseUrl/api/model ids/key，但仍缺 headers/authHeader/oauth、完整 model metadata、modelOverrides、sampling/cost tiers/compat，放“Provider 专家配置”。
- 凭据 UI 写 `auth.json` 或指导设置 process env；不要把 secret 复制进 `settings.json`。
- desktop launcher 的 process env/CLI args 是启动 profile，独立于持久 Pi JSON。
- extension-owned 文件只能由通用编辑器覆盖；无法静态映射。

## Start Here

先打开 `D:/software/nvm/v24.14.0/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`：它是高级设置表单的完整主 schema。随后以 `docs/models.md` 实现独立的 provider 专家编辑器；不要把 `docs/usage.md` 中的 CLI 操作批量转成 settings。
