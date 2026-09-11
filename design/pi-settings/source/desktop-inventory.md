# pi-desktop 设置页完整清单（Android 设计依据）

## 版本与核对范围

- 上游：`pi-desktop`，仓库版本 **0.1.0**，网络抓取副本目录标识 **`bef24f8fea631c0dc81db0196477d65b4e72c884589fbce734fedc3bd37f72e6`**（这是抓取工具目录名，不是已验证的 Git 提交号）。
- MCP 面板显示的当前 Pi SDK 版本：**0.84.0**。
- 设置一级分类及顺序必须保持为七项：**General / Appearance / Providers / Skills / MCP / Extensions / About**（中文分别为“通用 / 外观 / 模型与 Provider / Skills / MCP 插件 / 扩展 / 关于”）。桌面端是左栏导航、右侧内容；Android 宜改为“设置首页七项列表 → 各自独立二级页”，不要挤成横向七标签。
- 设置弹窗有标题“设置”和关闭操作；打开时刷新 Provider、权限及当前会话资源。Store 默认分类虽为 Providers，但 `/settings` 可直接定位任意分类。
- **模型选择与思考深度不是设置页标签或控件，而是在聊天输入区（composer）的快捷选择器。** Android 应放在聊天页输入区附近，不要塞入以上七个设置分类。

---

## 手机逐页内容清单

### 1. General（通用）

1. **语言**
   - 说明：“默认跟随系统语言”。
   - 二选一按钮：**中文、English**。
   - 当前项为选中态；点击立即切换。
2. **内置权限门控**
   - 右侧 Switch；配置尚未载入时禁用并降低透明度。
   - 说明全文：“开启后按规则拦截工具调用：高危命令（rm -rf、sudo、强推等）弹窗确认，其余放行。规则文件 `~/.pi/agent/permissions.json`，修改即时生效。关闭可换用自己安装的权限扩展。”
   - 切换采用乐观更新，写入失败恢复原值；错误由全局设置错误状态承接。

### 2. Appearance（外观）

1. **主题**
   - 说明：“深色模式适合夜间使用，跟随系统则自动切换”。
   - 三选一：**浅色、深色、跟随系统**。
2. **背景图片**
   - 说明：“选择一张图片作为应用背景，调节遮罩浓度保证文字可读”。
   - 无图片：虚线缩略图占位“—” + **选择图片**。
   - 有图片：显示 28:16 左右的缩略图 + **更换图片** + 红色 **清除背景**。
   - **仅有背景图片时显示**“遮罩浓度”滑杆与实时百分比；范围 **20%–100%**。

### 3. Providers（模型与 Provider）

#### 页头及状态

- 只读说明：“模型目录来自 SDK 内置数据与本地缓存，点击右侧按钮可从 pi.dev 拉取最新”。
- 右侧图标操作 **联网刷新模型目录**；初次加载或刷新中禁用，刷新中显示 spinner。显式联网刷新有 **15 秒超时**；普通刷新仅使用内置目录与本地缓存。
- 错误时顶部红底错误条；首次加载且列表为空时显示“加载中”；最终为空时显示“未发现可用 provider”。

#### 每个 Provider 行

- Provider 显示名。
- 自定义项显示“自定义”徽标。
- 只读信息：`{count} 个模型`；已配置且存在认证标签时追加 `· authLabel`。
- 状态胶囊：**已配置 / 未配置**。
- **仅已配置时**显示“测试”操作；测试中按钮禁用并 spinner。测试会用该 Provider 的第一个模型真实发送最小 `ping` 请求。
- 测试结果：成功绿底“连接正常（模型 ID）”；失败红底“测试失败：错误”。
- 始终有 **配置 Key / 更新 Key** 操作，点击展开/收起密码输入：
  - placeholder：“粘贴 API Key，保存到 `~/.pi/agent/auth.json`”；
  - Enter 或“保存”提交；空白时保存禁用；保存后折叠并清空输入。
- 删除动作条件：
  - **自定义 Provider**：显示“删除”，会同时删除 models.json 项以及可能存在的 auth.json 凭证。
  - **内置 Provider**：只有已配置且凭证来源为 `stored` 时显示“移除凭证”；环境变量、runtime、models.json key/command 等来源不能在此删除。
- 后端列表排序：已配置优先，其后按 ID 排序。认证来源可能为 `stored / runtime / environment / models_json_key / models_json_command`。

#### 添加自定义 Provider

- 默认仅显示整行虚线按钮：**+ 添加自定义 Provider**。
- 展开卡片标题“自定义 Provider”，字段不可漏：
  1. **ID**（必填；示例 `ai-ops`；只允许字母、数字、`-`、`_`，且首字符为字母或数字）；
  2. **显示名**（可选）；
  3. **baseUrl**（必填；示例 `https://api.deepseek.com`）；
  4. **API 协议下拉**（必填），全部选项：
     - `openai-completions`
     - `openai-responses`
     - `anthropic-messages`
     - `google-generative-ai`
     - `google-vertex`
     - `azure-openai-responses`
     - `mistral-conversations`
     - `bedrock-converse-stream`
     - `openai-codex-responses`
     - `pi-messages`
  5. **API Key**（可选，密码输入，存 auth.json）；
  6. **模型 ID**（必填，多行；逗号或换行分隔，示例 `deepseek-chat, deepseek-reasoner`）。
- 底部：**取消、保存**；提交中显示“保存中…”；ID/baseUrl/模型任一为空时保存禁用。
- 后端校验还要求至少一个非空模型、非空 API 协议；凭证文件写入权限为 `0600`。

### 4. Skills

- 数据只对应**当前项目（活跃会话）已加载**的 Skills，来源提示明确写出 `~/.pi/agent/skills` 与项目 `.pi/skills`。
- 无活跃会话：整页空态“没有打开的会话。先创建或打开一个会话，这里会显示该项目加载的 skills”。此时不显示标题/说明/诊断。
- 有会话：
  - 标题“已加载的 Skills”和来源说明；
  - 无条目时显示“当前项目没有加载任何 skill”；
  - 每条只读显示：名称、可选描述（最多两行）、路径（等宽、单行截断）、作用域徽标 **用户级 / 项目级 / 临时**；
  - `disableModelInvocation=true` 时额外显示“仅手动触发”。
- 若有诊断，显示“加载诊断”及每条诊断：类型 + `—` + 消息；error 用红色，其余（warning）用琥珀色。诊断 key 可取路径或消息。
- **本页没有启停、编辑、安装或删除 Skill 的操作。**

### 5. MCP

- **仅未实现占位，绝不能设计成可配置或已接入功能。**
- 页面唯一内容为居中弱化文字：“当前 pi SDK 版本（0.84.0）暂不支持 MCP，后续 SDK 支持后开放。”
- 没有服务器列表、添加按钮、开关、状态测试等任何真实能力。

### 6. Extensions（扩展）

页头标题“扩展”，说明：“从 pi.dev 社区目录浏览安装扩展，或查看当前项目（活跃会话）已加载的扩展”。其下是二段切换：**浏览社区 / 已加载**。

#### A. 浏览社区

1. 搜索框：placeholder“搜索社区包，如 mcp、web 搜索…”；输入后 **300ms 防抖**服务端模糊搜索，旧响应会丢弃。
2. 类型筛选 chips（全部保留）：**全部、扩展、技能、提示词、主题**；内部值为 all / extension / skill / prompt / theme。
3. 首次进入自动加载目录，并拉取一次 settings.json 已配置包列表。
4. 每个目录条目显示：
   - 包名；
   - 全部类型徽标（extension 用强调色，其余中性）；
   - 可选描述（最多两行）；
   - 可选作者；
   - 月下载量（`479565 → 479.6K`，`1234567 → 1.2M`）及“/月”；
   - **安装**按钮，安装中禁用并显示 spinner +“安装中…”；安装失败在该条目内红字显示原始错误；
   - 若能以 npm 包名匹配已配置源，改为“✓ 已安装”并提供卸载入口。仅 `npm:` 来源可以和目录包名匹配；支持剥离普通或 scoped 包的版本后缀。
5. 目录状态：
   - 首屏 loading：“加载中…”；
   - 错误：“无法加载社区包目录”+ 原始错误 +“重试”；
   - 零结果：“没有匹配的包，换个关键词试试”。
6. **分页/全部内容必须实现**：接口返回 `total / page / pageSize`，当前列表保留累计结果；`remaining = total - 已显示数`。只要 remaining > 0，底部显示 **“加载更多（剩余 N）”**；加载下一页时按钮禁用、spinner、“加载中…”，结果追加而不是替换。不要只做固定首屏。
7. 安装为用户级；成功后刷新已配置列表及当前会话已加载资源。

#### B. 已加载

- 内容只对应**当前项目（活跃会话）**。
- 无活跃会话：“没有打开的会话。先创建或打开一个会话，这里会显示该项目加载的扩展”。
- 有会话但扩展及错误都为空：“当前项目没有加载任何扩展”。
- 每条扩展只读显示：
  - 名称；
  - `hidden=true` 时“隐藏”徽标；
  - 作用域 **用户级 / 项目级 / 临时**；
  - 仅计数大于 0 时分别显示：`N 工具 / N 命令 / N flags / N 快捷键`；
  - 路径（等宽、单行截断）。
- 若扩展 source 与 settings.json 已配置 source 精确匹配，显示卸载入口；否则只读。
- 扩展加载失败：红底块标题“`N 个扩展加载失败`”，逐条显示等宽路径 + `—` + 错误。
- 卸载为**二次点击确认**：第一次垃圾桶；点击后变红字“确认卸载？”，鼠标移出或 3 秒恢复（Android 无 hover，应保留 3 秒超时或改标准确认 Dialog）；执行中禁用、spinner、“卸载中…”。作用域仅 user/project 可卸载。
- 注意：store 虽记录卸载错误 `removeErrors`，当前桌面面板**没有渲染该错误**；Android 若以“忠实复刻”为目标不要虚构成功提示，可在实现时至少用 Toast/Snackbar 防止静默失败，但这属于平台错误处理适配，不是上游现有可见内容。

### 7. About（关于）

- 居中布局：方形圆角深色 **Pi** 标识；应用名（未载入时 `Pi Desktop`）；“基于 Pi Coding Agent 构建”；“版本 …”（版本值加载前显示省略号）。
- 两个按钮：
  1. 默认“检查更新”；
  2. “源码与反馈”（有 repoUrl 时打开仓库，无值时点击不做事）。
- 更新按钮和状态随阶段变化：
  - checking：状态“正在检查…”（按钮仍是检查更新语义）；
  - available：显示新版本；自动更新构建可继续下载流程；
  - available + manual（如未正式签名的 mac 构建）：按钮变“前往下载”，打开 `${repoUrl}/releases/tag/v${version}`；
  - downloading：显示下载百分比；
  - downloaded：按钮变“重启并安装”，点击安装更新；
  - not-available：显示已是最新版本；
  - error：显示检查失败及消息。
- AppInfo 还含 Electron、Chrome、Node、平台、架构，但**当前关于页没有展示这些字段**，Android 设计不应擅自加为可见项。

---

## 聊天页专属：模型与思考选择（不属于设置页）

### 模型选择器

- 位于 composer，chip 显示当前模型标签；若找不到目录模型则显示 `provider/modelId`；完全未选则“默认模型”。
- 每个会话优先使用自己的模型，未设置时回退全局默认。
- 弹层按 Provider 分组，仅展示已配置 Provider 所提供的模型；组标题用 providerName，缺失时用 provider ID。
- 每行模型标签，当前项使用强调色和勾选；选择后立即关闭。
- 没有模型时复用“未发现可用 provider”空态。

### 思考深度选择器

- 同样位于 composer；每会话独立，未设置回退全局默认。
- 全部七档且顺序固定：**off、minimal、low、medium、high、xhigh、max**（界面使用对应本地化标签）。未知值显示时回退 medium 标签。
- 当前项强调色 + 勾选；选择后立即关闭。

---

## Android 视觉与交互建议（贴合当前 E Launcher）

依据当前 `MainActivity` 的实际视觉语言，而不是把 Electron/Tailwind 原样搬到手机：

1. **色彩**
   - 页面暖象牙底：`#F6F5F0`（IVORY）；主要文字炭黑：`#202521`（CHARCOAL）；主强调/链接/选中：`#267A69`（TEAL）；次要文字：`#656D69`（MUTED）。
   - 内容型设置页可用白色或暖象牙背景；卡片保持白色，边界使用极淡灰绿。危险操作继续用系统语义红色，不用 teal。
   - 延续首页右上角低透明 teal 圆形壁纸光斑，但设置二级页宜更克制，保证密集文字可读。
2. **排版层级**
   - 当前首页时间 64sp、日期 21sp、分区标题 25sp；底部设置面板标题 26sp，正文 15sp，辅助说明 13–14sp，按钮 15sp。设置页建议：顶栏标题 24–26sp；section 16sp；主行 15–16sp；说明 13–14sp；badge 11–12sp。
   - 不照搬桌面端 10–13px 的小字号；Android 保证正文及交互标签的可读性和系统字体缩放。
3. **形状与间距**
   - 当前设置底 Sheet 白底、顶部拖拽柄、28dp 圆角；状态块 18dp；普通按钮高至少 52dp；pill 与图标操作已有 48dp 触控尺寸。新设置沿用这些数值，任何图标按钮至少 48×48dp。
   - 一级设置用底部 Sheet/全屏入口皆可，但七分类适合全屏列表；二级页使用系统返回。Provider、Skill、Extension 长列表不要嵌套不可控的小滚动区。
4. **控件映射**
   - 桌面 hover/tooltip 在触屏不存在：图标若语义不够明显，使用文字按钮或 contentDescription + 可发现的 overflow menu；卸载确认改原生 AlertDialog 最稳妥。
   - 使用原生 Switch、RadioGroup/单选行、Slider、密码输入及系统图片选择器；加载与错误使用行内 progress、Snackbar/Toast，确保 TalkBack live region。
   - 遵循现有 App 的系统动画开关：页面 260ms 淡入/轻微位移、按压 0.96 缩放、展开 180ms；系统关闭动画时为 0ms。
5. **与现有导航关系**
   - 当前聊天标题点击打开“模型与搜索服务”，而 pi-desktop 的模型与思考是 composer 快捷项。整合设计时，保留聊天就地模型/思考快捷选择；七分类设置中的 Providers 负责凭证、目录、测试和自定义 Provider，二者职责不要混淆。
   - 当前 E Launcher 已有独立“桌面与手势”底 Sheet，这不在 pi-desktop 七分类中。若产品要求严格保持七分类，应把它保留为 Launcher 自身独立入口，不插成第八个 pi-desktop 分类。

---

# Code Context

## Files Retrieved

1. `package.json`（1–31）— 产品版本 0.1.0 与仓库身份。
2. `packages/desktop/src/renderer/src/components/settings/SettingsDialog.tsx`（1–87）— 七分类顺序、面板注册、弹窗框架。
3. `.../settings/GeneralPanel.tsx`（1–61）— 语言与权限门控。
4. `.../settings/AppearancePanel.tsx`（1–98）— 主题、背景图及条件滑杆。
5. `.../settings/providers/ProvidersPanel.tsx`（1–56）— Provider 页头、加载/错误/空态。
6. `.../settings/providers/ProviderRow.tsx`（1–148）— 每行状态、测试、Key、删除条件。
7. `.../settings/providers/CustomProviderForm.tsx`（1–129）— 自定义 Provider 全字段及提交条件。
8. `.../settings/SkillsPanel.tsx`（1–86）— Skills 行、空态、诊断。
9. `.../settings/McpPanel.tsx`（1–7）— MCP 明确为未支持占位。
10. `.../settings/ExtensionsPanel.tsx`（1–392）— 社区浏览、筛选、分页、安装/卸载、已加载列表与错误。
11. `.../settings/AboutPanel.tsx`（1–93）— 版本、仓库、更新状态机。
12. `.../components/composer/ThinkingPicker.tsx`（1–82）— 聊天区七档思考选择。
13. `.../components/composer/ModelPicker.tsx`（1–105）— 聊天区按 Provider 分组的模型选择。
14. `.../stores/settings.ts`（1–356）— 所有状态、刷新流、300ms 防抖、分页追加、安装卸载数据流。
15. `packages/shared/src/settings.ts`（1–65）— Provider IPC 类型与完整 API 协议枚举。
16. `packages/backend/src/settings.ts`（1–182）— 文件落盘、输入校验、认证、网络刷新超时、真实连接测试。
17. `packages/desktop/src/renderer/src/i18n/zh.ts`（160–273）— 所有设置中文可见文案，包括 MCP 0.84.0 提示。
18. `packages/shared/src/packages.ts`（1–32）— 目录项、分页、已配置包类型。
19. `packages/shared/src/session.ts`（331–375 及后续 LoadedExtension 字段）— AppInfo、Skill、Extension 可见数据结构。
20. `D:/project/e-launcher/README.md`（全文）— 当前 Android 产品、页面、动画、可访问性与边界说明。
21. `D:/project/e-launcher/app/src/main/java/com/example/launcherprobe/MainActivity.java`（1–1726；重点 23–29、270–465、1377–1471、1519–1702）— 实际色板、字号、composer、模型设置 Dialog、Launcher 设置 Sheet、圆角/按钮/动画实现。

## Key Code

```ts
const CATEGORIES = ["general", "appearance", "providers", "skills", "mcp", "extensions", "about"];
const CATALOG_TYPES = ["", "extension", "skill", "prompt", "theme"];
const remaining = total - packages.length;
```

```ts
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
```

```java
IVORY = rgb(246, 245, 240);  // #F6F5F0
CHARCOAL = rgb(32, 37, 33);  // #202521
TEAL = rgb(38, 122, 105);    // #267A69
MUTED = rgb(101, 109, 105);  // #656D69
```

## Architecture

设置面板从 Zustand `useSettingsStore` 读取状态，经 renderer `getPi()` IPC 调用 backend；Provider 配置最终写入 Pi agent 目录的 `auth.json` / `models.json` 并刷新 ModelRuntime。Skills/Extensions 是当前活跃会话的只读加载结果。Extensions 社区目录独立分页搜索，并通过已配置 source 判断安装/卸载状态。ModelPicker 与 ThinkingPicker 走 sessions store，属于 composer 会话态，不走设置分类。

## Start Here

先打开 `packages/desktop/src/renderer/src/components/settings/SettingsDialog.tsx` 确认七分类骨架，再按本文顺序逐面板实现；Extensions 内容和状态最多，应单独对照 `ExtensionsPanel.tsx` 全文，尤其不能漏“加载更多（剩余 N）”分页和 MCP 的未实现边界。
