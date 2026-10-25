# M19 / M20 交接：Windows / Linux TUI 与跨设备验收

> 状态（当前）：**M19 本期不交付**（按用户决定移出本期，模块编号保留；原规格保留为历史/后续计划；未验收的 TUI 代码只保存在 git stash `02f1396fda08d1b666ca83597ebbcea805c74d28`，仅作未来草稿，**禁止取回或删除**，不在交付树、不计完成）；**M20 进行中**，已交付 **M20-01 手机远端入口 + 限定范围跨设备联调**，另有 REDMI K80 真机限定运行验证（首次安装 + 覆盖重装、本机 Host 与 relay 到 Linux Host，见 §5.2/§8）；本期交付范围为原 20 个模块中的 19 个，当前 **18/19**。其后又完成一轮补充验收（9 组 GUI→Host 矩阵、Windows MSI/NSIS 与 Linux DEB/RPM 安装相关检查及 AppImage 两种运行模式、K80 真机 Shower/Widget/通知删除、Host/回执故障、群/DM、BC 与认证撤销，见 §5.6），并完成了 UI 退出 `FORTIFY` 已复现路径的修复与限定回归（7 次最终退出无新增 FORTIFY、Host/回执/客户端/数据保留均按预期，见 §5.7），另完成 K80 新 Host 未锁屏一次性定时与停机过期验收（见 §5.8），以及 K80 锁屏定时验收（Host 锁屏存活通过、exact 模式按时执行未通过，见 §5.9）；用户同时要求之后单独重做 UI 设计（见 §5.9，本轮不实施，不作为 M20 结项条件）。M20 仍未完成，不得记成 19/19 或全量验收完成。当前进度、已测范围与剩余项见 [重构路线图](refactor-roadmap.md) 末节与 [mobile/README.md](../mobile/README.md)。
> 本文其余部分是 M19/M20 开始前写下的交接计划与工程默认（建议、环境、差距记录保留）；正文中“完全未开始”“手机只有本机 Host”“缺远端入口”等描述只反映交接时点，**不代表现在的状态**。
> 基线：分支 `refactor/bot-host-core`，交接时提交 `5466b428`（父助手已用 git 核实；撰写时未执行 git）。若接手时 HEAD 已前进，先读后续变更再动手，**绝不 `reset`/`clean` 回旧基线**。
> 标记约定：**【事实】** 已在仓库或已验收记录中成立；**【建议】** 本文为后续实施给出的工程默认，接手者需按当次任务确认；**【待实现】** 现在不存在。

## 1. 阅读顺序与工作规则

1. [`AGENTS.md`](../AGENTS.md)：目录职责、构建先决条件、按改动范围选验证、子代理约定。
2. 本交接：M19/M20 范围、建议顺序、环境与差距。
3. [`docs/refactor-roadmap.md`](refactor-roadmap.md)：里程碑表（M19/M20 行）与各模块完成范围。
4. [`docs/next-generation-architecture.md`](next-generation-architecture.md) §7（外壳与 Android 生命周期）、§9（工程待验证与端到端验收场景）。
5. [`host-core/README.md`](../host-core/README.md) 模块 14（统一服务/35 个 v2 方法）、模块 17（桌面客户端与 broker）、模块 18（Tauri Android 界面）。
6. [`desktop/README.md`](../desktop/README.md)（Tauri 桌面客户端用法/数据路径）、[`mobile/README.md`](../mobile/README.md)（Android 界面与构建）。

规则【事实】：单工作树单写者；worker 只做静态开发，不运行构建/测试/设备；不新增测试，父助手做端到端验收；不改 `.pi`、`AGENTS`。**本次撰写仅改文档，不改依赖与锁**；后续实现若确需新增依赖，必须同步更新对应 `package-lock.json`，按项目约定由父助手生成/验证，禁止无关升级。本轮及后续 M19/M20 的授权以当次任务为准，本文不新增任何权限。

## 2. 架构红线（M19/M20 不得改变）

- 目标 Host 持有 Durable、BC 上下文、模型调用、工具与原始历史；中心只做设备注册、认证与路由，不存聊天正文或模型凭据。【事实】
- 公开业务方法固定 **35 个**；M19/M20 不新开 HTTP/Relay 协议、不改方法表。【事实】
- 关闭客户端窗口/TUI/观察流**不停止** Host 或 Agent；只有显式 `abort`、`stopWork` 才向目标 Host 发停止请求。【事实】
- 冻结客户端可先确定的 ID 与目标：客户端生成的 requestId/messageId、选定的 targetDeviceId/botId/scopeId，以及原 payload；submissionId 等 Host 返回字段由 Host 生成，客户端**不得预先编造**。未知结果只做只读对账，**不自动重放**，是否重发由用户显式决定。【事实】
- TLS/Origin/回环 Bearer 认证与 CA 固定规则不变；local 连接只接受既有客户端支持的回环地址（以 client 校验为准，不允许 LAN/远端地址），本交接**不新改 URL 校验规则**。【事实】
- 目标相对权限：`getWorkActivity`/`stopWork`/`resumeWork` 按 bot+scope；room 与 Bot-DM 语义不同，成员修订走 CAS。【事实】
- 文件选择只产生 `{name, path, size}` 本地路径引用，**不存在跨设备上传协议**。【事实】
- Android 保留原签名、数据路径与既有能力（聊天记录、附件、草稿、Widget、Shower、语音、导航恢复、定时任务）。【事实】

## 3. 可复用的现有组件

### 3.1 事实表

| 路径 | 符号 / 导出 | 用途与已知限制 |
| --- | --- | --- |
| `host-core/desktop-client.js` | `openDesktopClient({dataRoot,onEvent})` → 同步 client `{request(op,params), close()}`；另有 `normalizeDesktopError`、`derivePendingProfileKey` 与 `DESKTOP_MAX_IN_FLIGHT_REQUESTS=8`、`DESKTOP_MAX_OBSERVATIONS=8`、`DESKTOP_CALL_TIMEOUT_MS=25000` | M17 纯 Node broker，无 Tauri/Rust 依赖；18 个操作注册在 `OP_HANDLERS`。**未**进入 `host-core` 包 exports，只能按相对文件路径 import。 |
| `host-core/desktop-client.d.ts` | `DesktopConnectionInput`（`kind: local` 需 `url`+`token`，可带 `expectedDeviceId`；`kind: relay` 需 `url`+`deviceId`+`token`，可选 `ca`）、`DesktopOperationMap`、`DesktopObservationEvent`、`DesktopClientStatus`、`OpenDesktopClientOptions` | 类型与常量来源；18 个操作 = `connect`/`disconnect`/`status`/`devices`/`call`/`settings_get`/`settings_set`/`service_status`/`pending_enqueue`/`pending_get`/`pending_list`/`pending_send`/`pending_reconcile`/`pending_cancel`/`ui_get`/`ui_set`/`observe`/`unobserve`（写全拼，避免被读成 `get`/`list` 这类不存在的操作）。 |
| `host-core/desktop-client-cli.js` | stdin/stdout JSONL 驱动 broker | sidecar 入口，由 `build-desktop.js` 打包；TUI 可参考其 init/close 帧流程，但建议进程内复用 broker。 |
| `host-core/desktop-ui-store.js` | `desktop-ui.sqlite`（schema v1：clientId、profiles、drafts、intents） | 明确不存 token/CA；损坏或更高版本拒绝打开、不自动重置。 |
| `host-core/pending-client.js`、`pending-store.js` | 待发送账本（`pending/<profileKey>/client-pending.sqlite` + `pending-owner.sqlite` 独占锁） | `profileKey = sha256(JSON.stringify([kind,url,relay 客户端 deviceId]))`，同一 endpoint 的不同显示名称档案**共用**一本账，不等于 UI profileId。 |
| `host-core/remote-control-client.js`、`remote-control-protocol.js` | 认证中继客户端与线协议 | 跨设备连接的既有实现；不得另造协议。 |
| `host-core/control-client.js`、`control-client.d.ts`、`local-control-adapter.js` | 本机 HTTP 控制客户端与适配层 | broker 的 local 分支复用它们；CLI 也直接使用。 |
| `desktop/web/src/api.ts`、`BotChats.tsx`、`Scopes.tsx`、`PendingPanel.tsx`、`SettingsPanel.tsx`、`drafts.ts` | 桌面 GUI 对同一 broker 的调用与状态模式 | 作为 TUI 交互与状态机对照，**不要**把 GUI 组件搬进终端。 |
| `host-core/host-service-cli.js` / `control-cli.js` / `remote-control-cli.js` / `relay-server-cli.js` / `device-link-cli.js` / `relay-registry-cli.js` / `pending-cli.js` / `message-cli.js` / `control-server-cli.js` | 9 个仅直接运行时解析参数的 CLI，各自带内联 `USAGE` | 环境准备与人工验证入口（见 §6）。 |
| `mobile/web/src/main.tsx`、`web/src/Host.tsx`、`mobile/web/src/remote-client.ts`、`app/src/main/java/com/example/launcherprobe/BotHostUiBridgeService.java`、`BotHostClient.java`、`BotHostTauriPlugin.kt` | Android Tauri UI、手机远端页与本机同 UID 私有桥 | M20-01 起本机 Host 页与“其他设备”远端页并列（见下节）；远端页复用桌面 `App`，私有入口为 `clientRequest`/`clientObserve`/`clientUnobserve` 与观察帧 `clientFrame`（无 `clientClose`），公开仍是 4 个 Tauri 命令；client child 用独立 `files/bot-client`，不启动本机 Host/FGS。 |

### 3.2 broker 行为（事实）

- `openDesktopClient` 同步返回对象；`request`/`close` 返回 Promise；`onEvent` 接收 `DesktopObservationEvent`。公开接口只有 `request`/`close`；TUI **不需要**新增 Tauri 的 ACK 命令，按 broker 的事件与释放契约消费即可。
- 上限：8 个在途请求、8 个观察、25 s 调用超时；`observe`/`unobserve` 是显式动作，客户端退出或断线不通知 Host 停止。
- `settings_get`/`settings_set`/`service_status` **仅 local** 可用；relay 会话调用会被拒绝（“operation is supported only on a local Host connection”），远端设置写入不提供。
- `devices`：local 返回单行目录，relay 走 `RemoteControl.listDevices`。
- pending：`pending_enqueue`/`pending_get`/`pending_list` 离线可用；`pending_send`/`pending_reconcile` 未连接时快速失败 `NOT_CONNECTED`；`pending_cancel` 只取消本地未发送记录。
- 连接 token 与 relay CA（≤64 KiB PEM）只在会话内存，`redactConnection` 输出不含它们。

### 3.3 TUI 复用约定【建议】

- **进程内复用 broker**：M19 不新建 HTTP/Relay 协议，也不额外拉起 sidecar 进程；TUI 直接按相对路径 import `desktop-client.js`。
- TUI 默认使用**独立 dataRoot**（仓库外本机独立目录），不直接打开 GUI 正在使用的 `desktop-ui.sqlite`/pending 目录；同一目录同一时间只能有一个写者。

## 4. M19：Windows / Linux TUI（本期不交付，编号保留；本节为历史/后续计划的首版实施范围）

### 4.1 必做功能

| 能力 | 说明 |
| --- | --- |
| 连接档案 | local（url+token，可带 `expectedDeviceId`）/ relay（url+deviceId+token，可选 CA PEM）；**只持久非密字段**（kind/url/deviceId/显示名等），token 与 CA 仅会话内存，不写进 profiles/drafts、日志或终端回显 |
| 设备目录与目标 | `devices` 列表、明确当前目标 Host；切换目标时不复用旧连接的回执 |
| Bot | 列表、创建（冻结 requestId，可 `find-request` 对账）、按原 ID 查询 |
| 主私聊 | 多行输入、LIVE 观察流与原始历史分页分离、受理与完成区分（`status` 只读对账） |
| 群 / DM | room 与 Bot-DM 范围浏览、成员选择、历史/LIVE、room 发布用户消息、基本 scope 创建与成员修订 CAS；**不放宽作者/成员权限**（发布仍以用户身份，Bot 作者由 Host 决定） |
| 显式停止 | 主私聊 `abort` 与 `stopWork`/`resumeWork` 都是独立明确操作，不与客户端退出绑定；退出/断线**不发** Host stop |
| 草稿与 pending | 持久草稿（CAS 清空成功后才发送）、查看/发送/只读对账/本地取消；丢失回执保留冻结记录 |
| local Host 设置 | `settings_get`/`settings_set` 的 CAS 编辑（无模型凭据编辑；relay 明确不可用）；冲突保留本地编辑并读取远端新 revision，未知写入锁定到只读对账并显式采用基线，**不自动重放** |
| memory | 不要求专属 UI；既有 `control-cli` 的 memory 子命令继续可用 |

首版**不做**：语音、Shower 画面、Widget、终端标签页插件系统、自动安装模型、跨设备文件上传、新调度器。原生文件 picker 不是 TTY 必需；即使支持也只产生路径引用。

### 4.2 入口【待实现】

- 规划新增 `host-core/tui-cli.js`（进程入口，解析参数、组装视图）与 `host-core/tui/` 下的必要视图模块；**这些路径与命令目前不存在**，文档中的 `node host-core/tui-cli.js` 是规划命令，接手者实现后才可写进使用说明。
- 只在 TUI 确实需要私有能力时做小补充，并回归 M17 调用方（`desktop-client-cli`、桌面 GUI、构建）；不扩 35 个 Host 方法。

### 4.3 终端依赖【事实 + 建议】

- 【事实】根 `package.json` 直接依赖 `@xterm/xterm` 与 addon（beta 版），但那是 WebView 终端（`web/src/RemoteTerminal`），**不是原生 TTY TUI**。
- 【事实】`host-core/package.json` 未直接声明终端库，`host-core/package-lock.json` 无 tui/terminal 匹配；`pi-runtime/package-lock.json` 里 `@earendil-works/pi-tui 1.1.0` 只是 `pi-coding-agent` 的传递依赖，**未核实**其为终端 UI 实现，也不能靠它冒充已完成的选型。
- 【建议】**M19 第 0 步**：先核对 `pi-tui 1.1.0` 的 API、许可证与 Windows/Linux 支持；确认后在选择它的那个包的 `dependencies` 里**直接锁版声明**，不要升级 Durable/BC 或依赖全局 Pi 安装。

### 4.4 交互默认【建议】

| 项 | 默认 |
| --- | --- |
| 常显状态 | 目标 Host、Bot、scope、连接 phase 与 generation |
| 焦点 | `Tab` 在列表/输入/面板间切换 |
| Enter | 列表项上确认；编辑区插入换行 |
| 发送 | `F5` 发送，同时提供可发现的命令（例如菜单项） |
| `Ctrl+C` | 只走客户端退出/草稿保存路径；`abort`、`stopWork` 必须单独明确操作 |
| `Esc` | 只关闭当前弹层 |
| 小终端 | 宽度不足时退化为单栏；Unicode/emoji 按显示宽度对齐 |
| 非 TTY | 给出明确说明后退出，不进入交互循环 |
| 退出 | `finally` 中还原 raw mode、光标与 alternate screen |

快捷键必须在 Windows 与 Linux 的真实 TTY 里验证；不要假设 `Ctrl+Enter`/`Alt+Enter` 一定可用。

### 4.5 实施顺序与稳定检查点【建议】

| 检查点 | 内容 |
| --- | --- |
| M19-01 | 依赖选型核实 + TTY 骨架（raw mode/尺寸/还原，Win/Linux 各跑一次） |
| M19-02 | broker 连接档案、设备目录、目标切换、状态栏 |
| M19-03 | 主私聊：多行输入、LIVE 与历史分页、受理 vs 完成 |
| M19-04 | 冻结 pending 与草稿 CAS（丢失回执、重启不重放） |
| M19-05 | 群/DM：历史、LIVE、发布、成员 CAS、stopWork/resumeWork |
| M19-06 | local 设置 CAS 编辑；relay 明确不可用 |
| M19-07 | 故障与退出：断网、回执丢失、切目标旧响应不覆盖、退出还原终端 |

M19 完成条件【建议】：Windows 与 Linux 各自真实 TTY 运行；中文与 emoji 多行输入、窗口缩放；local 与 TLS relay 均可用；断网/回执丢失/重启不重放；切换目标时旧响应不覆盖新状态；取消观察或关闭 TUI 时 busy Host 仍完成；终端状态被还原；包信息、README、许可证与独立提交齐备。这些条件**均未完成验收**：M19 已按用户决定移出本期，未验收代码只在 git stash `02f1396f`（仅未来草稿，禁止取回或删除），不计交付；这些条件也不再是本期或 M20 的完成条件。

## 5. M20：跨设备集成、打包与真机验收

M20 不只是“跑一遍测试”：它包含完成原定场景所必需的集成补齐。

### 5.1 手机端远端入口：历史缺口已由 M20-01 补齐

- 【历史事实】交接时 Android Tauri UI（`mobile/web/src/main.tsx` + `web/src/Host.tsx`）只有本机 Host，没有连接档案、设备目录或远端 Host 选择界面；远端 profile + 设备目录只存在于 M17 桌面客户端。
- 【当前】手机界面并列 **本机 Host / 其他设备**，远端页复用桌面 `App`/`BotChats`/`Scopes`/`PendingPanel`：连接 profiles、设备目录、明确 target、Bot 创建与按原 ID 查询、主私聊/room/DM 聊天与历史、pending。token 与 relay CA 只在会话内存；持久档案/草稿/pending 在独立 `files/bot-client` SQLite，与本机 `files/bot-host` 隔离。
- 【当前】远端页经独立 Node Mobile client 模式 broker（不启动本机 Host/FGS）；UI 关闭/EOF 只释放 client child，不停止远端 Agent；主动重连清旧 identity，不自动重连/重放。
- 【保留约束】不把桌面可执行 sidecar 复制到 Android，不把私有同 UID 的 Binder socket 当网络通道。【历史建议】用 CLI 脚本代替手机 UI 不能算通过；本轮手机 UI 路径已有实际联调记录。

### 5.2 客户端 × 目标矩阵【建议：M20-02】

| 客户端 \ 目标 Host | Windows Host | Linux Host | Android Host |
| --- | --- | --- | --- |
| Windows GUI（M17 Tauri，NSIS 安装版） | 已测（本轮显式选择/发送/LIVE/历史读回） | 已测（本轮，经 TLS relay） | 已测（本轮，经 relay） |
| Linux GUI（M17 Tauri，Release + 私有 Xvfb/WebKitWebDriver） | 已测（本轮） | 已测（本轮；同机历史另计） | 已测（本轮，经 relay） |
| Windows TUI（M19） | 已移出本期，不交付 | 同左 | 同左 |
| Linux TUI（M19） | 已移出本期，不交付 | 同左 | 同左 |
| Android UI（M18 + M20-01 远端页，K80 真机） | 已测（本轮，经认证 TLS relay） | 已测（本轮，经 relay；K80 真机已复验） | K80 本机路径已限定验证（首次安装，非旧版本升级）；矩阵中经 relay 已验证 |

- M20-01 阶段实测环境（历史）：Windows x64 Node 26.12.1、Linux x64（Ubuntu 26.04.1）Node 22.19.0、`emulator-5556`（Android 36/x86_64）；隔离真实 TLS relay 在 Linux，Windows 与 Linux Host 上线。模型与回复是合成服务，不付费。其后补充验收换用 Windows 安装版 GUI、Linux Release GUI（私有 Xvfb/WebKitWebDriver）与 K80 真机 UI，见 §5.6。
- 跨端创建续聊已按手机创建 Bot → Windows 桌面 GUI 经 TLS relay 续聊验证（有限范围）；其后补充验收已跑完 Linux GUI 全矩阵、Host/回执故障、群/DM、BC 与认证撤销（见 §5.6），DM 智能行为仍未验；TUI 客户端已移出本期，不再列入本矩阵的待跑项。
- 最终验收：APK sha256 `2b50fccfaef5b1da5f8f47777fe4aea30b91f90d57af9a123e78443be52bba39` 已原签名覆盖安装；同一目标断开后重连并显式选回原设备，面板自动收起；离线草稿只入 pending，重连后仍 pending，目标 `getSubmission` 返回 `SUBMISSION_NOT_FOUND`，不自动重放，用户式本地取消到 `CANCELLED`/`not-sent`；原 Host 6 库 + 新 client 3 库完整性/FK 通过，client 目录合成 token 零匹配（profile 名称阳性对照命中）。
- K80 真机（REDMI K80 / 24117RK2CC，Android 16、arm64-v8a、页 4096；旁置 K90 未操作）是较早 K80 阶段的限定运行验证（历史）：同 APK 先首次安装（安装前设备无此包，故**不**是旧版本用户数据迁移验收）再覆盖重装 `-r`（原签名保留）；冷启动无 Host Node/FGS，显式启动后真实 ARM64 Node + specialUse FGS 运行，本机 Bot 中文/emoji/多行写入真实 Durable/BC 历史并取回合成 SSE 回复；UI 进程被 kill 后默认进程与 Host Node 同 PID 保持、重开读到持久回复（关闭前受理回执未捕获，不写精确 busy 接纳时序）；打开“其他设备”后 Host/client 两个 ARM64 Node 并存且 client 用独立数据目录；经真实 CA TLS relay 连 Linux Host，提交唯一 K80 marker 多行消息并在 Linux 原始历史读到输入与回复；8 路 LIVE 各 snapshot、批量 close 后再开 8 路再关闭通过；设置页显式重连后 client Node 退出、本机 Host 同 PID 继续且 UI 无循环；清空合成配置/alias 并停 Host 后覆盖重装，Host state + client store + shared_prefs 字节一致、7 份 SQLite integrity/FK 通过，重开冷态无 Node；该阶段检查时未发现 crash buffer 条目（其后另一时点复查的 UI 退出阶段 FORTIFY 日志与 `EXIT_SELF`/status 0 见 §5.6）。页为 4 KiB，不宣称 16 KiB 设备实测；手机 UI × Windows Host 已在补充验收矩阵中通过（见 §5.6），但该 K80 阶段路径是手机 UI → Linux Host + K80 本机 Host；该阶段未跑 `notifications` 组。

- **同平台不同机器也算跨机**：M17 的“本机已测”只覆盖客户端与 Host 在同一台机器的情况，**不能**当作跨机通过。
- local 连接只接受受支持的回环地址（以既有 client 校验为准，不允许 LAN/远端地址）；跨设备一律走认证 TLS relay，不得把“本机地址”当远端直连。
- 每格记录时区分：已跑、本模块待跑、功能前置未实现、环境未授权/不可用。

### 5.3 场景编号（内容以架构 §9 为准，不在此重抄）

| 编号 | 场景 | 来源 |
| --- | --- | --- |
| M20-03 | 跨端创建与续用（手机创建 Linux Bot、Windows 桌面 GUI 用原 ID 续聊、离线只待发、无重复创建） | 架构 §9-1 |
| M20-04 | BC 与副作用恢复（多次压缩/重启/旧 refs、工具结果不明不重做外部动作） | 架构 §9-2 |
| M20-05 | 自然群聊与 DM（全员收件/人类纠正优先/DM 隔离/持久 stop 与显式 resume） | 架构 §9-3 |
| M20-06 | 断线与历史副本（固定 ID 重投/去重/缺序补史/副本只证明已知范围） | 架构 §9-4 |
| M20-07 | Android 覆盖迁移（原签名升级/旧数据/FGS/Widget/Shower/语音） | 架构 §9-5 |
| M20-08 | 认证与容量故障（凭据轮换/撤销、错误 CA、慢消费者、8 请求/8 观察/25 s 边界、客户端退出不影响 busy 任务） | 本文补充【建议】 |

### 5.4 发布矩阵【建议：M20-09】

| 目标 | 现状 / 要求 |
| --- | --- |
| Windows MSI | M17 只用 WiX `dark` 解包核实，**未安装**；本轮已实际安装（安装目录由既有测试安装的注册表路径决定）、GUI 聊天、重装、卸载、数据哈希保留通过 |
| Windows NSIS | M17 已静默安装到私有目录并运行；本轮同版本从 M17 基线升级、GUI 聊天、卸载、数据哈希保留通过 |
| Linux DEB | M17 已实际安装运行；本轮安装 M17 基线后同版本覆盖更新、GUI 聊天、卸载、数据保留通过 |
| Linux RPM | M17 未安装；本轮在 Fedora 44 容器内以普通非特权 GUI 用户安装/重装/卸载并保留数据 |
| Linux AppImage | M17 已 `--appimage-extract-and-run` 运行；本轮 FUSE 正常挂载与解包模式均通过（首轮 AT_SPI_BUS 隔离错误属验收环境，已修环境未改产品/无障碍） |
| Android ARM64 | 已由 REDMI K80 真机限定运行（首次安装 + 同 APK 覆盖重装，页 4 KiB）；其后修复并限定回归了 `:tauri_ui` 退出路径（§5.7，新 APK sha256 `9956…`）；旧版本覆盖升级与完整许可仍未测；**16 KiB 页适配与专项运行验收按用户决定本期排除**（不作结项门槛；既有 ELF 对齐与 `zipalign -P16` 设置与历史未测事实保留） |
| 远端 GitHub Actions | 接线已实现，**未实际运行** |

TUI 客户端已移出本期（M19 不交付），不在本期发布矩阵内；若未来恢复 M19，才需“可用的 Node 入口”，独立分发形式按目标环境确定，不要虚构当前不存在的 TUI 安装包。

M20-11：远端 GitHub Actions 实际运行（接线已存在，尚未跑）并把 run 链接/日志摘要记入证据；不要用本地构建代替。

### 5.5 真实服务层【建议：M20-10】

真实 Hindsight / ASR / 付费模型联调是独立验收层：先合成服务打通链路，再用真实服务与凭据重跑。没有环境或授权就记为未测/受阻，**不能**把合成服务结果算作真实服务通过。

### 5.6 补充验收结果（本轮，M20 仍未完成）

运行产品提交 `9c495e3`（证据 `source-unchanged.json` 的 productCommit），HEAD/范围提交 `3e69968`；本轮无产品或测试代码修改。全部模型选择与回答为合成夹具，不是付费或真实模型验收。证据在仓库外目录 basename `e-launcher-m20-acceptance-1792827403446`；完整结果与限制见 [重构路线图](refactor-roadmap.md) 末节。

- **通过**：9 组 GUI→Host 矩阵（Windows/Linux/Android 客户端 × Windows/Linux/Android Host，显式选择/发送/LIVE/历史读回）；Windows MSI/NSIS 与 Linux DEB/RPM 的安装、升级/重装、卸载与数据保留，以及 AppImage 的 FUSE 挂载与解包两种运行模式及配置保留（AppImage 未做安装/卸载）；K80 真机真实 Shower、实际桌面 Widget、通知删除；Linux Host 在 `LIVE busy=true` 且请求已 `placed` 时 SIGKILL 后原 submission 77 完成（不推断已开始模型 HTTP 派发）；客户端回执丢失后 `unconfirmed` → 只读对账回原 submission 73 `done`，对已接受记录再次 send 返回原回执、历史仍只有一条；群聊发布/更正与 DM 30.001 s 超时后迟到回复、原 request 只读读取、私有历史隔离；BC 两次压缩 2 块 9276 tokensCompressed 且重启后块/refs 与 13 条原历史不变；连接类 `not-sent`（错误 CA/旧 token/撤销 token/重连）与活动观察唯一 `REVOKED`（`unconfirmed`）终止。
- **不是普通场景**：回执失败由调试器暂停后强杀注入；Host 重启结合了自有合成 relay 凭据轮换（原临时启动环境丢失，见证据 `host-restart-environment-note.json`），不是环境不变的纯重启。
- **未通过/不计通过**：原 `notifications`/`widget`/`voice-continuity` instrumentation 失败状态不变（未改产品或断言）；手工 Widget/通知路径为 ADB 注入，不是手指验收；Windows GUI busy 后 WM_CLOSE 的最终进程退出时序未确认，不记 busy 任务完成证据；语音只验证拒绝麦克风后正常返回与草稿保留；K80 是首次安装+覆盖重装、4 KiB 页，不是旧版本迁移或 16 KiB 设备；较早的 `FORTIFY ... destroyed mutex` 日志（pid 30306，UI 退出阶段）与 `EXIT_SELF`/status 0、`trace=null` 并存，当时原因未定位；该现象其后已普通复现（K80 按返回，3 条 FORTIFY + UI 进程 `EXIT_SELF`，默认进程仍在），该已复现退出路径已完成修复与限定回归（见 §5.7）；无 native 符号化栈，C 全局析构归因仍为有依据假设。
- **仍未验收**：真实模型/ASR/Hindsight、远端 push/CI、长时锁屏/ROM 后台与定时执行（该轮口径；新 Host 未锁屏一次性与停机过期其后已验收，见 §5.8）、真实旧版迁移、传输饱和/竞态；16 KiB 页适配与专项运行验收本期不做（见 §9）。本期仍为 **18/19**。

### 5.7 退出路径修复与回归（2026-10-25）

基提交 `dd91f68`；产品改动仅 `mobile/src-tauri/src/lib.rs`（Android 只拦 `RunEvent::ExitRequested{code:None}`）与 `app/src/main/java/com/example/launcherprobe/TauriMainActivity.java`（非 `isChangingConfigurations` 的最终 `onDestroy` 结束隔离 UI 进程）；未写/未改测试代码。新 APK sha256 `9956832a59355254fc25a05ff19d7964cc1fe09be7b25544b574851cfcb350c4`、签名 `6f6ff43d800aa2eb8444a78d4f3992a0157f5bae2ca0a31a97da753187d01ffb`，实际 Android ARM64 产品构建 35 秒；证据仓库外 basename `e-launcher-m20-followup-1792852771822`（入口 `exit-fix-acceptance.json`）。

- 旧版普通 Back 复现 3 条 FORTIFY（默认进程仍在）；新版 7 次最终退出无新增 FORTIFY、crash buffer 不变，UI 按设计在 SDK 清理后自 SIGKILL、默认进程 8109 保留（`exit-cold-loops.json`）。
- 20 s 合成任务 submit 33 受理后关闭 UI，UI 不存在期间由同 Host PID 19203 完成，重开原请求读到 `done`（`busy-accepted.json`/`busy-after-reopen.json`/`busy-continuity-result.json`）。
- client 24420 随 UI 结束、重开新建 25431，Host 不受影响；未连 relay，不宣称重测活跃远端 LIVE（`client-release-result.json`/`client-reopened.json`）。
- `hide`、方向变化与旧会话/旧 Host 路由均保持进程（旋转是 manifest 已处理配置变化，不是强制 Activity 重建）；原签名覆盖安装后备份的 Host/client/prefs/配置逐项一致（`data-install-diff.txt`）。
- 无 native 符号化栈，`libhwui` 锁归属与 C 全局析构仍为有依据假设；模型仍为合成夹具。
- 收尾：Host 停、配置恢复 revision 7（`providers=[]`、`defaultModel=null`、`relay=null`、`aliases={}`），通知权限/flags 与方向 lock 0 恢复，模型服务/端口/logcat/终端停；数据与 APK 保留。

### 5.8 新 Host 一次性定时与停机过期（K80，未锁屏）

产品提交/HEAD `e30a8b4`，无产品与测试代码修改；证据在仓库外目录 basename `e-launcher-m20-schedules-1792862818326`（入口 `schedule-acceptance.json`）。走新 Host 的 `BotHostSchedules`/`AlarmManager` 与真实 `schedule_task` 工具，不用旧 `ScheduledTasks` 页面或旧引擎；模型回复与工具选择均为自有合成服务。设备充电、屏幕亮、未锁屏。

- **通过（只限这两个一次性场景）**：01:55 一次性任务在 UI 进程关闭期间实际触发，scheduled 输入在 01:55:00.061 进入原始历史（本次观测迟 61 ms），固定请求 ID 对应 submission 55 `done`，仅 1 条 scheduled 输入；第二任务 01:59 到期前显式 stop Host、到期时 Host 仍未启动，显式重开后 `latestRun=skipped_offline`、无 scheduled 输入，原请求 `SUBMISSION_NOT_FOUND/responded`。两条任务按自有 id/revision 用真实工具删除，最终 `list` 为 `tasks[]`；旧任务库起始为空，未走旧引擎执行（`created.json`/`online-run-and-stop.json`/`restart-and-readonly-check.json`/`final-run-observations.json`/`cleanup-tools.json`）。
- **权限与配置**：精确闹钟权限起始未授予，验收时临时授权，结束恢复 UID appop `default` 且系统开关关闭；未改电池、自启、HOME、无障碍或锁屏配置。本轮开始时 Host 已运行且通知权限已开启，结束保留该起始运行态与通知 `USER_SET` 授权。配置内容恢复为空 `providers`、`defaultModel=null`、`relay=null`、`aliases={}`（CAS revision 7→8 测试→9 恢复）；临时模型服务、ADB 转发与 reverse 已停，调试终端由 operator 关闭后未重开，UI 回到 App。
- **证据说明**：终端关闭前未另存完整最后 CDP 回执，`restore-terminal-receipt.json` 只保留该回执尾部；配置恢复见 `config-restored.json`；系统 FGS、Host PID 9476/默认进程 29670 与持久状态 `running` 的读回见 `restore-system-check.txt`。
- **不覆盖**：真正锁屏、长时待机/未充电 Doze、周期/日历规则的设备组合、旧引擎真机执行、真实模型。（锁屏已另行测试，见 §5.9。）

### 5.9 K80 锁屏定时（exact 模式）与后续 UI 重设计（本轮）

产品仍 `e30a8b4`，文档基（HEAD）`dce956d`；无产品与测试代码修改。证据在仓库外目录 basename `e-launcher-m20-lockscreen-1792893191893`（入口 `lockscreen-result.json`、`timing-failure.json`）。用户授权 10 分钟安全锁屏，设备全程充电；10:00:10 熄屏、10:00:10.725 锁屏显示，用户 10:12:09.377 解锁。本次显式选择 `alarmMode=exact`（`setExactAndAllowWhileIdle`），产品默认 `alarmClock` 本轮未测。

- **通过（仅 Host 锁屏存活）**：4/8/10 分钟检查时 Host 与默认进程仍为同一 PID 9468/29670，FGS 在，UI 不存在，`mWakefulness=Dozing`、`mIsPowered=true`、`mState=ACTIVE`（`locked-initial.txt`/`locked-4min.txt`/`locked-8min.txt`/`locked-10min.txt`）。本轮条件为充电锁屏，设备未进入深度 Doze。
- **未通过（exact 模式锁屏按时执行）**：A 应 10:02，实际 scheduled 输入 10:12:14.596（迟 614596 ms）；B 应 10:07，实际 10:12:09.533（迟 309533 ms）；submission 95/91 最终 `done`，各 1 条 scheduled 输入（`timing-failure.json`/`native-runs.json`/`task-readback.json`）。系统日志 10:12:09.471 才出现该应用 `R(alarm start)`，两条 native run 均 10:12:09.484 才创建（`schedule-system-log.txt`/`lock-events.txt`）。最终 `done` 只证明解锁后执行成功。
- **归因边界**：系统闹钟相关处理与 native run 创建均延后到解锁之后，具体 OEM 策略仍需对照核实；默认 `alarmClock` 尚未测试。未改电池优化、自启、HOME、无障碍，未加保活或生产代码补丁。
- **清理**：两条自有任务按真实工具 id/revision 删除并 `list tasks[]`（`cleanup-tools.json`）；配置恢复 `providers=[]`/`defaultModel=null`/`relay=null`（revision 9→10 测试→11 恢复）、`aliases={}`（`restored-state.json`）；临时精确闹钟权限恢复未授予、UID appop `default`；保留起始通知 `USER_SET` 授权与 Host 运行态（Host 16131/默认 9256/UI 9258）；自有模型服务、ADB 端口与终端均已关闭。
- **后续独立 UI 工作（用户提出，本轮不实施）**：用户评价当前界面太乱，要求之后单独重做设计。记录的问题：顶栏把隐藏、旧会话、设置、旧 Host 状态与重连、设备导航混排；默认页偏 Host 调试管理（状态/UUID/角色/目录）而非日常聊天（`ui-redesign-note.json`，截图 `ui-after-unlock.png`）。不作为 M20 新增结项条件。

## 6. 环境与授权

- 【事实】Android 侧的历史授权设备只有保留 userdata 的 `emulator-5556` / `m15_api36`（Android 36, x86_64）；M18 结束时已停止模拟器与自有夹具，清理测试 CA、临时权限与 forward/reverse，配置空、revision 10、8 份 DB 完整。M20-01 复用同一 `emulator-5556` 做手机远端页联调，另用 Windows x64（Node 26.12.1）与 Linux x64 验收机（Ubuntu 26.04.1，Node 22.19.0）。后续真机环节另按用户明确授权使用 REDMI K80（24117RK2CC，Android 16/arm64-v8a，页 4 KiB），旁置 K90 未操作。M17 的 Windows/Linux 本机历史运行/授权不因此失效，但当前新的目标主机、新物理设备与新服务仍需按本次任务明确授权。
- 【事实】本轮授权边界是“手机远端入口 + 限定跨设备联调”：不 push、不启动 CI；在环境中发现物理设备不构成本次授权，后续需用户选具体设备/服务并允许推送 CI。
- 【建议】不要连其它物理设备，也不要因为“能看到设备”就自动视为授权；M20 的真机、新远端主机与真实付费服务需要当次明确目标与授权。历史 SSH 地址/PID/端口不代表现在的状态。
- 【建议】M17 的 Windows/Linux 旧服务或隧道状态未在 M18 逐一复核：先只读盘点归属，再决定是否停止，**不要**按历史 PID 直接 kill。
- 【建议】保留所有历史数据，尤其既有未发送记录；**禁止**重放 `schedule-restore-normal.sql`、旧提交/导入/定时操作。
- 【建议】默认新建仓库外唯一隔离根（示例变量 `M20_ROOT`），Host、中心、客户端各自独立目录；安装目录不等于数据目录，GUI 安装验收优先用独立 OS 测试用户/VM 或源码明确支持的数据目录覆盖，别假设改 `LOCALAPPDATA` 就能改 Tauri KnownFolder 路径。
- 【建议】保留 `debug.keystore`；不要靠重签、卸载清数据来“解决”升级问题。

### 6.1 最小现有命令（均已存在）

```bash
git status --short && git log --oneline -5
node --version                      # 需 ≥ 22.19
npm --prefix host-core ci
node host-core/host-service-cli.js --help
node host-core/control-cli.js --help
```

双终端本机 Host 健康读取示例（`M20_ROOT` 为仓库外绝对路径，`CONTROL_TOKEN` 由操作者在两个会话中设成同一个有效隔离令牌；文档不生成、不保存任何真实秘密，未设变量会立即失败而不会落到 `/host`）：

```bash
# 终端 A：起本机统一服务（默认 serve，127.0.0.1:8787）
: "${M20_ROOT:?set M20_ROOT to an absolute directory outside the repo}"
: "${CONTROL_TOKEN:?set CONTROL_TOKEN to the same non-empty test token in both shells}"
node host-core/host-service-cli.js serve --data-root "$M20_ROOT/host" --token-env CONTROL_TOKEN --port 8787

# 终端 B：只读打印 host info（使用与终端 A 相同的令牌）
: "${CONTROL_TOKEN:?set the same token here}"
node host-core/control-cli.js host --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN
```

Relay、CA 与模型配置的完整参数见 [`host-core/README.md`](../host-core/README.md) 模块 14 与各 CLI 的 `--help`；不要凭记忆编造参数。

构建入口【事实】：桌面用 `npm run desktop:prepare` / `npm run desktop:build`（详见 [`desktop/README.md`](../desktop/README.md)）；Android APK 用 `.\gradlew.bat :app:assembleDebug -PlauncherAbis=arm64-v8a,x86_64 --no-daemon --console=plain`（详见 [`mobile/README.md`](../mobile/README.md)）。**TUI 启动命令尚未存在**（M19 本期不交付），实现前不要在任何文档里写成“可运行”。

## 7. 已知差距（集中）

| 差距 | 现状 |
| --- | --- |
| Android 远端入口 | 已由 M20-01 补齐（手机 UI 可经 relay 连接远端 Host，见 §5.1/§5.2）；手机 UI × Windows Host 的跨机聊天已在补充验收矩阵中通过（§5.6）；K80 真机另做本机 Host 与 Linux Host 限定验证 |
| TUI | M19 已移出本期（编号保留）；原规格保留为历史/后续计划，未验收代码只在 git stash `02f1396f`，仅未来草稿、禁止取回或删除，不在交付树、不计完成；不作为本期或 M20 完成条件 |
| M17 Relay GUI 联调 | Windows GUI 本轮已经真实 TLS relay 续聊手机创建的 Bot；其后补充验收已跑完 Linux GUI 跨机全矩阵（9 组 GUI→Host 均通过，见 §5.6） |
| ARM64 运行时 | 已由 REDMI K80（Android 16/arm64-v8a，4 KiB 页）限定运行验证：本机 Host、remote client、CA TLS relay 到 Linux Host；旧版本覆盖迁移与 16 KiB 设备未测 |
| 真实 Hindsight / ASR / 付费模型 | 未联调 |
| 锁屏 / 长时后台定时 | Host 锁屏存活已通过（同 PID、FGS 在、UI 不在）；exact 模式锁屏按时执行未通过，调度被延后到解锁后执行，待处置（§5.9）；未充电深度 Doze 与周期/日历规则仍待；默认 `alarmClock` 未测 |
| Android UI 视觉与信息层级 | 用户要求之后单独重做（顶栏入口混排、默认页偏 Host 调试管理），本轮不实施，不作为 M20 结项条件（§5.9） |
| 远端 GitHub Actions | 工作流接线已实现，**未实际运行**，本轮不启动 |
| MSI 安装 / RPM 安装 / AppImage FUSE | 其后补充验收已实际安装/卸载 MSI、安装/重装/卸载 RPM，并以 FUSE 与解包两种模式运行 AppImage（详见 §5.4/§5.6） |
| Linux busy Host 关闭客户端连续性 | 已通过：客户端会话删除、Host 进程保留、同请求 `done`（submission 57）；Windows 侧 busy 后 WM_CLOSE 的退出时序未确认 |
| `notifications` 普通检查 | 立即删除清空通知断言在 stage1 新 APK 仍失败（M16 起既有问题）；普通检查基线曾通过一次；产品与断言均未改，不宣称修好；其后手工删除路径（真实聊天 + 既有 API）通过，但不等于 instrumentation 通过 |
| `widget` / `voice-continuity` instrumentation | `widget` 普通检查超时（MIUI 拒绝后台启动，JDB 续跑仅作诊断）；`voice-continuity` 建会话前超时；手工 Widget/拒绝麦克风路径通过，但不改称 instrumentation 通过 |
| `FORTIFY ... destroyed mutex` 退出日志 | 原记录（pid 30306，2026-10-24 15:22:33，UI 退出阶段；系统 `EXIT_SELF`/status 0、`trace=null`）已保留，其后普通复现同一路径（3 条 FORTIFY、默认进程仍在）；修复后 7 次最终退出无新增 FORTIFY、UI 自 SIGKILL（见 §5.7）；无 native 栈，`libhwui` 锁归属仍为假设 |

调查归因可以，但不要删除断言或用“调试器下通过”替代普通通过。

## 8. 证据与清理【建议】

- 记录结构：run id、commit、平台/arch、自有资源与清理状态；场景 id、步骤、预期、实际；原始业务 ID/目标/配置 revision；APK/安装包 hash；DB 完整性检查与有限 marker 扫描（带阳性对照）；失败与未测分开列。
- 截图、日志、一次性驱动脚本一律放**仓库外**；ADB 注入与真实手势分开记。
- 仓外证据索引（用目录 basename 定位，不含用户家目录与私钥）：
  - `e-launcher-desktop-client-1792726911550`：`module17-completion.json`、`module17-delivery-evidence.json`。
  - `e-launcher-tauri-android-1792774112316`：`module18-completion.json`、`module18-commit-manifest.json`、`stage12-package-acceptance.json`、`cleanup-complete.json`、`notification-final-summary.json`。
  - `e-launcher-m19-m20-1792820895768`：M19/M20 本轮验收产物（合成模型、不付费）。只按目录 basename 引用，不写用户名绝对路径、机器地址或测试 token。
  - `e-launcher-k80-1792825796727`：K80 真机限定验证 `k80-verification.json`（不含用户名路径、设备 serial 或临时 token）。
  - `e-launcher-m20-acceptance-1792827403446`：其后补充验收（9 组 GUI→Host 矩阵、MSI/NSIS/DEB/RPM 安装相关检查与 AppImage 两种运行模式、K80 原生能力、故障/群聊/DM/BC/认证、清理）。入口文件 `acceptance-current-scope.json`、`matrix-results.json`、`packaging-progress.json`、`manual-notification-result.json`、`manual-widget-result.json`、`manual-voice-denial.json`、`k80-native-checks-final.json`、`receipt-recovery-result.json`、`host-crash-result.json`、`host-restart-environment-note.json`、`group-dm-result.json`、`bc-result.json`、`auth-result.json`、`cleanup-complete.json`；`k80-native-checks-progress.json` 仅为中途历史状态；安装包哈希见 `windows-bundle-sha256.txt`/`linux-bundle-sha256.txt`。不写凭据。
  - `e-launcher-m20-followup-1792852771822`：UI 退出 `FORTIFY` 修复后的限定回归（入口 `exit-fix-acceptance.json`；另有 `exit-reproduction.json`、`exit-cold-loops.json`、`busy-accepted.json`、`busy-after-reopen.json`、`busy-continuity-result.json`、`client-release-result.json`、`client-reopened.json`、`hide-result.json`、`rotation-result.json`、`legacy-chat-result.json`、`data-install-diff.txt`、`phone-restore-result.json`）。
  - `e-launcher-m20-schedules-1792862818326`：K80 新 Host 一次性定时与停机过期（入口 `schedule-acceptance.json`；另有 `created.json`、`online-run-and-stop.json`、`restart-and-readonly-check.json`、`final-run-observations.json`、`cleanup-tools.json`、`config-restored.json`、`restore-terminal-receipt.json`）。未锁屏，不写凭据。
  - `e-launcher-m20-lockscreen-1792893191893`：K80 锁屏定时与后续 UI 需求（入口 `lockscreen-result.json`/`timing-failure.json`；另有 `created.json`、`native-runs.json`、`task-readback.json`、`locked-initial.txt`/`locked-4min.txt`/`locked-8min.txt`/`locked-10min.txt`、`lock-events.txt`、`schedule-system-log.txt`、`cleanup-tools.json`、`restored-state.json`、`ui-redesign-note.json`）。含充电显示 Dozing 的锁屏窗口与 UI 截图 `ui-after-unlock.png`；不写凭据或完整机器路径。
  - 这些文件在原机器的系统临时目录，**不是仓库文件**；换机器需移交到可访问的仓外位置。没有原文件时，以仓内限定说明作为历史摘要，并重新建新夹具，不得声称复跑。
- 首轮模拟器/桌面收尾已完成：最终窗口、client Node、自有 Windows/Linux Host、relay、Mockoon、SSH 转发、3 个自有终端与模拟器均已停止；userdata 与 fixture 记录保留，自有 adb 19220 forward 已删；该阶段未操作物理设备；不外推其他 M20 项。
- 其后补充验收的收尾已完成（见证据 `cleanup-complete.json`）：K80 临时 models/settings 按原字节哈希恢复，临时授权（含 `POST_NOTIFICATIONS`）、自有 Shizuku、测试 APK、测试会话与 Widget、自有 ADB 转发、手动 UI dump 均已清理并归档；手工 Widget/通知检查的临时 fixtures 清理字段也已由 pending 改为 complete（`manual-widget-result.json`/`manual-notification-result.json`）；桌面自有 Host/relay/模型服务/SSH 隧道/Xvfb/driver/容器与三个验收终端已停止，原 M17 driver 保留；保留 APK、五种桌面安装包、合成数据集与仓外证据。M19 stash 未动。
- 收尾：只停自有进程、释放自有观察与虚拟屏、清理测试 CA/转发/临时权限、恢复自有测试配置；只读检查保留数据。每个模块单独汇报 commit、产物、已测、未测、已知失败与清理结果。

## 9. 收尾顺序（当前）

1. M19 已按用户决定移出本期（编号保留）：原规格作为历史/后续计划保留；未验收 TUI 代码只在 git stash `02f1396f`，仅作未来草稿，**禁止取回或删除**，不进入交付、不计完成；其终端界面/快捷键/TUI 续聊验收不再是本期或 M20 的完成条件。恢复 M19 需用户重新明确授权，并单独验收、提交。
2. M20 仍进行中，本期交付范围为原 20 个模块中的 19 个（当前 18/19）；已交付 M20-01 不等于 M20 完成，不得把 M20 或本期记成已完成。
3. M20 完成条件：每个 M20-xx 先具备所需功能/环境，再逐项给出证据；任一必需项未完成或未给出处置，就不能算通过。剩余验收项：真实 Hindsight/ASR/付费模型、远端 CI（不 push/不启动）、锁屏与长时待机/未充电 Doze 后台（新 Host 未锁屏一次性触发与停机过期处理已有证据，见 §5.8；锁屏 exact 模式按时执行已测未通过、待处置，默认 `alarmClock` 待独立对照，见 §5.9；不因此扩大成所有定时功能失败）、ARM64 真实旧版覆盖迁移（K80 本机 Host/remote client 已限定验证，不计完成）、完整传输饱和/竞态；UI 重做为用户提出的独立后续工作，不进 M20 结项条件（§5.9）。16 KiB 页适配与专项运行验收按用户决定不在本期范围、不作为结项门槛（4 KiB 页历史事实与既有 ELF/zipalign 对齐设置保留，不改构建配置）。已通过的 Linux GUI 全矩阵、MSI/NSIS/DEB/RPM 安装相关检查与 AppImage 两种运行模式、Host/回执故障、群/DM、BC 与认证撤销，以及 UI 退出 FORTIFY 的已复现路径（§5.7）不再列入待跑（限制见 §5.6/§5.7）。

## 10. 交接任务模板（未来操作者直接用）

```text
接手 M19（本期不交付，未来恢复需用户重新明确授权）：未验收 TUI 代码只在 git stash 02f1396fda08d1b666ca83597ebbcea805c74d28，仅作未来草稿，**禁止取回或删除**。
未获用户明确授权前不要动 TUI；得到授权后再从 stash 取回，并先读 AGENTS.md、docs/m19-m20-handoff.md、docs/refactor-roadmap.md、docs/next-generation-architecture.md §7/§9、host-core/README.md 模块 14/17。
再核对 @earendil-works/pi-tui 1.1.0 的 API/许可证/Win+Linux 支持，按交接 §4 的顺序做 M19-01..07，
进程内复用 host-core/desktop-client.js，不新建协议、不扩 35 方法；依赖与锁只在确认选型后按项目约定同步，不做无关升级。
完成 M19 后单独验收、提交并汇报，停止等待 M20 任务。
```

```text
接手 M20：跨设备集成、打包与真机验收。先读本文 §5/§6 与架构 §9，并看 docs/refactor-roadmap.md 末节的当前进度。
M20-01（手机远端入口 + 限定跨设备联调）已交付，不重复实现；补充验收（§5.6）已跑 9 组 GUI→Host 矩阵、MSI/NSIS/DEB/RPM 安装相关检查与 AppImage 两种运行模式、K80 原生能力、故障/群聊/DM/BC/认证，不重跑也不把它们当全量；下一步按剩余项推进：
真实 Hindsight/ASR/付费模型（M20-10）、远端 push/CI（M20-11）、锁屏与长时后台（新 Host 未锁屏一次性与停机过期已验收，见 §5.8；锁屏 exact 模式按时执行未通过、待处置，默认 `alarmClock` 待独立对照，见 §5.9；未充电 Doze 仍待）、ARM64 真实旧版覆盖迁移（K80 已限定验证，见 §5.2/§8）、传输饱和/竞态；16 KiB 页适配与专项运行验收本期不做，不作为结项门槛。
跨端创建续聊已按手机→Windows 桌面 GUI 有限验证；TUI 客户端已移出本期，不作为待办。每项标注已跑/待跑/前置未实现/环境不可用；未完成不把 M20 或本期记成已完成；需要新物理设备/付费服务/推送 CI 时先向用户申请授权。
```
