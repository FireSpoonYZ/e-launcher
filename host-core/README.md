# @e-launcher/host-core

本机 Bot/Host 核心。模块 1 提供 Bot 定义与主私聊身份登记；模块 2 接入 Pi Durable 长期主私聊、历史与执行恢复；模块 3 内嵌 Billion Context；模块 4 接入本机工具（read/write/edit/bash 与 grep/find/ls）；模块 5 接入本机长驻控制 API 与客户端；模块 6 接入 Bot 主私聊直播预览（认证本地 SSE、运行时 watch、客户端与 CLI）；模块 7 接入本机持久消息账本（messages.sqlite：作用域/成员修订、不可变信封、outbox、落地去重 ACK、本地收件/历史/缺口、特权离线 CLI）；模块 8 接入认证设备中继与 Host 消息投递（中心只存设备注册；复用模块 7 outbox，本机进程网络端到端）；模块 9 在认证中继上增加固定 10 个 JSON 方法的远程 Host 控制（独立多客户端角色、Node 客户端与一次性 CLI；父助手已完成本机独立进程 171/171 个端到端检查点验收，范围见下文）；模块 10 已完成群与 Bot DM 的独立工作上下文（显式被动导入、独立 Durable/BC、本机 API/CLI；父助手完成 149/149 个检查点，实测范围与限制见下文）。总计划 20 个模块、已完成 10 个。运行时由单 Host 所有者持有，跨进程身份稳定。包正式名为 `@e-launcher/host-core`；当前仓库尚无 workspace/包安装连接，示例直接从仓库根导入本地文件（见下文）。

整体方向见 [下一代多端 Bot 架构设计](../docs/next-generation-architecture.md)（目标架构，部分已实现），交付计划与完成/剩余模块见 [重构路线图](../docs/refactor-roadmap.md)。

## 实现与边界

- 需要 Node >= 22.19.0（package.json 中 `engines.node` 声明的最低版本）。存储用 Node 内置 SQLite（`node:sqlite`），数据库文件即 `dataRoot/host.sqlite`；新的 dataRoot 会自动建立（含必要的目录与库文件）。
- `openHost` 负责登记；`openRuntime` 负责 Pi Durable 主私聊、内嵌 BC 及本机工具。模块 5/6 提供认证本地 HTTP/SSE，模块 7 提供本机持久消息账本，模块 8/9 接入认证中继、投递与远程 JSON 控制。模块 10 在同一 Runtime 内增加隔离的群/DM 被动工作上下文，不新增运行时所有者；自动群决策与通信工具仍属后续模块。
- 写入由 SQLite 事务保护，重复请求重试安全。
- `host.sqlite` 仍只保存登记数据，Durable 使用独立的 `durable.sqlite`；`runtime-owner.sqlite` 的 SQLite 事务锁保证单进程所有权。
- SQLite 宿主适配尚未在 Android 验证；旧运行链路未被替换。
- dataRoot（数据库/记录）与 cwd（工具默认工作目录）分离：不 `process.chdir`；工具在 Bot Host 中运行，以 cwd 为默认工作目录，write/edit 会写入该目录。

## 数据

每个 Bot 恰有一条记录：

```ts
interface BotRecord {
  botId: string;            // node:crypto randomUUID
  deviceId: string;         // 本机身份，跨进程持久
  role: string;             // 原文保留，不规范化
  cwd: string;              // 本机绝对目录；规范化（路径整理）的是 cwd
  modelRef: string | null;  // 缺省 null
  primaryConversationId: string; // 创建时生成的主私聊记录 ID
  createdAt: string;        // ISO 字符串
}
```

Bot 创建后即有主私聊记录；收发消息、推理与历史不属本模块。

## 可导入 API

仓库根目录的 ESM 中直接导入（当前仓库未安装 `@e-launcher/host-core`，不要按未安装的包名导入）：

```js
import { openHost } from './host-core/index.js';

const host = openHost({ dataRoot: '/path/to/data-root' });
try {
  const bot = host.createBot({
    requestId: 'req-001',   // 非空白字符串，保留原文
    role: 'assistant',      // 非空白文本，保留原文
    cwd: '/path/to/cwd',    // 本机绝对目录
    // modelRef 可省略或为 null；字符串须为非空白文本
  });
  host.getBot(bot.botId);        // BotRecord | null
  host.findByRequest('req-001'); // BotRecord | null
  host.listBots();               // 稳定排序的 BotRecord[]
} finally {
  host.close();                  // 幂等，无保活/定时器
}
```

关键语义：

- `createBot` 重复 requestId 且 cwd 规范化后相同、role/requestId 原文相同、modelRef 相同（缺省按 null）：返回原 BotRecord。
- 内容不同：抛 Error，`code='REQUEST_CONFLICT'`，不产生多余数据。
- 重试先按 requestId 查已受理请求，不要求原 cwd 仍存在；只有新请求才 `statSync` 确认目录。
- `getBot`/`findByRequest` 查无返回 null。
- 输入错误 `code='INVALID_ARGUMENT'`；目录不存在/不是目录 `code='INVALID_CWD'`；数据库更高版本 `code='UNSUPPORTED_SCHEMA'`；其他 I/O 与 SQLite 错误不吞。
- 错误用普通 Error.code，不引入框架。

## CLI

```bash
node host-core/cli.js init --data-root '/path/to/data-root'
node host-core/cli.js create   --data-root '/path/to/data-root'   --request-id req-001   --role assistant   --cwd '/path/to/cwd'
```

`create` 返回 BotRecord，抄下 botId 后可用于 `get`：

```bash
BOT_ID='粘贴create返回的botId'
node host-core/cli.js get --data-root '/path/to/data-root' --bot-id "$BOT_ID"
node host-core/cli.js find-request --data-root '/path/to/data-root' --request-id req-001
node host-core/cli.js list --data-root '/path/to/data-root'
```

可选 `--model-ref`：不传则记录为 null；传入时须为非空白字符串，例如 `--model-ref 'provider/model-name'`：

```bash
node host-core/cli.js create   --data-root '/path/to/data-root'   --request-id req-002   --role assistant   --cwd '/path/to/cwd'   --model-ref 'provider/model-name'
```

- `init` 输出 {deviceId, dataRoot}；`create`/`get`/`find-request` 输出 BotRecord 或 null；`list` 输出数组。一条 JSON 到 stdout。
- 应用错误以一条 `{"error":{"code":...,"message":...}}` 输出到 stderr，exitCode=1，finally 中 close。Node 22 的内置 SQLite 还会向 stderr 输出原生 `ExperimentalWarning`，stdout 的 JSON 格式不受影响。
- `--help` 无须 `--data-root`。
- `get` 用 `--bot-id`，`find-request` 用 `--request-id`。

## 文件

- `store.js`：openStore(dataRoot)，返回 {deviceId, createBot, getBot, findByRequest, listBots, close}。
- `host.js`：openHost({dataRoot})，返回 {deviceId, dataRoot, createBot, getBot, findByRequest, listBots, close}。
- `cli.js`：CLI 入口。
- `index.js`：导出 `openHost`、`openRuntime`、`openControlServer`、`openMessageLog`、`openRelayRegistry`、`openRelayServer`、`openDeviceLink`、`openRemoteControl`、`RemoteControlError` 与控制 IO 辅助（`ControlHttpError`、`createControlAuthorizer`、`readControlBody`、`writeControlJson`、`writeControlError`）。
- `index.d.ts`：登记接口，以及 `Runtime`、`PrimarySubmission`、`HistoryPage`、`OpenRuntimeOptions`（含可选 `bashPath`/`toolPaths`）、模块 6 直播预览类型（`LiveMessage`/`LiveHistoryItem`/`LiveTool`/`LiveGeneration`/`BotLiveState`/`BotLiveChanges`/`BotLiveSnapshot`/`BotLiveUpdate`/`BotLiveDataFrame`/`BotLiveEnd`/`BotLiveFrame`/`BotWatchEnd`/`BotWatch`）、模块 7 消息账本类型（`MessageMember`/`MessageAuthor`/`MessageScope`/`PublishMessageInput`/`MessageEnvelope`/`MessagePeer`/`MessageAck`/`StoredMessage`/`MessageCursor`/`MessagePageOptions`/`MessageOutboxOptions`/`MessageStreamStatus`/`MessageHistoryPage`/`MessageInboxPage`/`MessageOutboxPage`/`MessageDeliveryStatus`/`MessageLog`/`openMessageLog`）、模块 8 中继类型（`RelayDevice`/`RelayRegistry`/`RelayServerStatus`/`RelayServer`/`DeliveryPumpStatus`/`DeviceLinkStatus`/`DeviceLink`/`openRelayRegistry`/`openRelayServer`/`openDeviceLink`，`OpenDeviceLinkOptions.control` 可选）、模块 9 远程控制类型（`RemoteControlOutcome`/`RemoteControlMethodMap`/`OpenRemoteControlOptions`/`RemoteControl`/`RemoteControlError`/`openRemoteControl`）等类型。
- `index.d.ts` 的模块 10 增量：`MessageInboxOptions`、`WorkContextRecord`、`WorkSyncOptions`、`WorkSyncResult`、`WorkHistoryCursor`、`WorkHistoryPage`、`WorkContextStatus` 与 Runtime 的四个工作上下文方法；不新增根 JS 导出。
- `work-context-docs.js` / `work-context-codec.js` / `runtime-work-contexts.js`：模块 10 的内部持久文档、来源事件编码与被动导入引擎，不作为根 API 导出。
- `messages.js`：模块 7 门面 `openMessageLog({dataRoot})`，组合 openHost 与 openMessageStore；协议边界只验证一次。
- `message-protocol.js`：模块 7 协议校验与规范化（`messageError`/`assertId`/`assertRevision`/`normalizeScope`/`normalizePublish`/`normalizeEnvelope`/`normalizePeer`/`normalizeAck`/`normalizePageOptions`/`streamIdForScope`/`digest`/`assertScopeMessage`）。
- `message-store.js`：`openMessageStore(dataRoot, deviceId)`，建库 `messages.sqlite`（user_version=1）与事务读写。
- `message-queries.js`：`createMessageQueries(db, {deviceId})` 只读查询（getScope/listScopes/getMessage/history/inbox/outbox/deliveryStatus/streamStatus）。
- `message-cli.js`：模块 7 特权离线 CLI（scope/get-scope/scopes/publish/get/receive/ack/history/inbox/outbox/delivery/stream）。
- `host-environment.js`：HostExecutionEnv（NodeExecutionEnv 子类）；仅命令字符串经 Git Bash/bash 执行，argv 数组与文件操作直接透传。
- `grep-tool.js` / `find-tool.js` / `ls-tool.js`：grep（rg）、find（fd）、ls 工具。
- `search-bin.js`：rg/fd 固定版本、asset 规格与解析顺序；`prepare-tools.js`：显式下载并安装 rg/fd 的 CLI。
- `control-client.js` / `control-client.d.ts`：控制客户端（`./control-client` 子路径导出），由协作任务提供。
- `control-server-cli.js` / `control-cli.js`：模块 5 两个 CLI；`control-cli.js` 的 `live` 子命令在模块 6 增加，模块 10 增加 `work-get`/`work-sync`/`work-history`/`work-context`，仍经同一本机 HTTP 服务调用。
- `runtime-live-projection.js` / `runtime-live.js`：模块 6 直播预览投影与 `Runtime.watch`。
- `control-live.js`：模块 6 SSE 路由 `GET /v1/bots/:botId/live`。
- `control-live-client.js`：模块 6 SSE 流式解析与 `readControlLive`。
- `relay-protocol.js`：模块 8 协议常量、凭证/URL/帧校验与编码（`MAX_RELAY_FRAME_BYTES`/`RELAY_HELLO_TIMEOUT_MS`/`RELAY_CLOSE`/`assertDeviceToken`/`parseRelayUrl`/`readClientFrame`/`readServerFrame`/`encodeRelayFrame`/`DELIVERY_REJECT_CODES`）。
- `relay-registry.js` / `relay-registry-cli.js`：中心设备注册库（`relay.sqlite`，唯一写入口）与唯一写 CLI。
- `relay-server.js` / `relay-server-cli.js`：认证中继服务（WebSocketServer noServer + TLS/loopback 规则）与其 CLI。
- `message-delivery.js`：内部投递泵（不导出），在线扫描 outbox、退避与诊断。
- `device-link.js` / `device-link-cli.js`：Host 链路（ws 客户端、Hello/ready、所有权锁、重连/blocked）与其 CLI；模块 9 起 `device-link-cli` 增加可选配对 `--control-url` 与 `--control-token-env`，配置控制适配器后 hello 带 `role:'host',controlProtocol:1`。
- `remote-control-protocol.js`：模块 9 协议常量与方向性帧校验（`CONTROL_METHODS`/`CONTROL_ERROR_CODES`/`MAX_CONTROL_JSON_BYTES`/`CONTROL_TIMEOUT_MS`/`CONTROL_CLIENT_TIMEOUT_MS`/`CONTROL_MAX_CLIENT_CALLS`/`CONTROL_MAX_HOST_CALLS`/`CONTROL_MAX_PENDING`/`normalizeControlCall`/`readControlClientFrame`/`readControlServerFrame`）。
- `relay-server.js`：模块 8/9 认证中继服务（WebSocketServer noServer + TLS/loopback 规则、control-* 有界路由与清理）。
- `local-control-adapter.js`：`createLocalControlAdapter({url,token})`，目标本机回环 Control API 适配（仅字面 `http://127.0.0.1` 或 `http://[::1]`，路径 `/`）。
- `host-control.js`：`createHostControlReceiver({deviceId,execute,send})`，Host 侧控制接收器（最多 8 个活动调用、无队列）。
- `remote-control-client.js`：模块 9 Node 控制客户端（`openRemoteControl`/`RemoteControlError`）。
- `remote-control-cli.js`：模块 9 一次性控制 CLI（10 个固定方法）。

## 本次模块验收

父助手在 Windows / Git Bash 下以 Node 26.8.2 和最低版本 Node 22.19.0 执行了真实 CLI 跨进程验证：创建、列举、两种查询、重启后身份与记录稳定、重复请求、请求冲突和输入错误均通过。8 个进程并发首次建库及提交同一请求，最终只保留一个 Bot；不同请求并发也能完整保存。

通过 SQLite 触发器模拟 Bot 写入后、主私聊写入前的失败，确认 Bot、主私聊及请求记录一起回滚，修复后同请求可正常提交。更高版本、未知表结构和损坏数据库均被拒绝且原文件保持不变；外键、完整性检查及公开类型声明检查通过。

验收数据与报告保存在仓库外临时目录，没有新增测试文件。Android 和 Linux 尚未运行本模块；本次验收不包含 Durable/BC 或现有 Android 应用集成。

## 模块 2：Durable 长期主私聊

依赖固定为 `@earendil-works/pi-durable`、`@earendil-works/pi-ai`、`@earendil-works/chord` 1.3.0。先在仓库根执行：

```bash
npm --prefix host-core ci --ignore-scripts --no-audit --no-fund
```

模块 1 的同步 API、创建幂等语义和 `host.sqlite` schema v1 均保留。Bot 的公开主私聊 UUID 与 Durable 内部数字会话 ID 在同一 Durable commit 中建立映射；不是把旧 SDK 的 Session 或运行检查点直接导入。

### 显式模型配置

当前配置入口支持 OpenAI completions 兼容服务。将以下 JSON 保存到仓库外的 `runtime-config.json`，按实际服务修改 URL 和模型：

```json
{
  "defaultModel": "local/model",
  "providers": [{
    "id": "local",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "apiKeyEnv": "HOST_MODEL_API_KEY",
    "models": [{"id": "model", "contextWindow": 32768, "maxTokens": 1024}]
  }]
}
```

`apiKeyEnv` 指定环境变量名，凭证仅在请求时从该变量读取，不写入 Bot、历史或中心；无密钥的本地服务可明确省略此字段。模块不扫描、迁移或覆盖旧 `models.json` / `auth.json`，不执行密钥命令，暂未迁移 OAuth。`modelRef` 已指定的 Bot 使用自身选择；为空时，首次主私聊采用配置中的默认值并持久保存，以后改变默认值不自动替换已有会话模型。配置可选包含 `bashPath` 与 `toolPaths`（见模块 4），解析后传给 `openRuntime`。

### 命令与 API

```bash
DATA_ROOT='/path/to/host-data'
CONFIG='/path/to/runtime-config.json'
BOT_ID='粘贴登记接口返回的botId'
node host-core/runtime-cli.js send --data-root "$DATA_ROOT" --config "$CONFIG" --bot-id "$BOT_ID" --request-id message-001 --text '你好'
node host-core/runtime-cli.js status --data-root "$DATA_ROOT" --bot-id "$BOT_ID" --request-id message-001
node host-core/runtime-cli.js history --data-root "$DATA_ROOT" --bot-id "$BOT_ID" --limit 50
node host-core/runtime-cli.js wait --data-root "$DATA_ROOT" --config "$CONFIG" --bot-id "$BOT_ID" --request-id message-001
```

从仓库根 ESM 可导入 `openRuntime`。它接收 `{dataRoot, models?, defaultModel?, bashPath?, toolPaths?}`，其中 `models` 为 pi-ai 的 Models 集合；省略时为空集合，可用于不调用模型的历史和回执查询。`bashPath`/`toolPaths` 见模块 4。运行时提供：

| 方法 | 语义 |
| --- | --- |
| `submit(botId, {requestId, text})` | 持久提交输入并返回受理状态 |
| `wait(botId, requestId)` | 等待已有提交，进行中工作可恢复；已结束回执直接返回 |
| `getSubmission(botId, requestId)` | 被动查询，无此提交返回 null |
| `history(botId, {limit?, cursor?})` | 原始条目按时间顺序分页，默认 50，上限 200 |
| `abort(botId)` | 停止该主私聊的当前执行与待处理输入，等待确认 |
| `resume()` | 启动已有持久任务的调度，不创建新输入 |
| `close()` | 幂等关闭资源，保留未完成工作供之后恢复 |

提交回执包含公开 `botId` / `conversationId`、`requestId`、Durable `submissionId`、`status`、`answerText` 和 `reason`。状态为 queued、placed、done 或 unanswered。相同请求 ID 和相同正文返回原提交；正文不同报 `REQUEST_CONFLICT`。已失败的提交重试相同 ID 仍返回失败回执，继续对话应发送新请求 ID。

历史页的 `nextCursor` 只用于对应 Host、Bot 和扫描条件，调用方应原样传回。历史和 status 不启动模型；未有 Durable 会话时返回空历史/空回执。运行时已被其他进程持有时报 `RUNTIME_BUSY`，不会打开第二个写入者；进程崩溃后由操作系统释放锁。

成功命令输出一行 JSON；send/wait 得到 unanswered 时仍输出回执并退出 2；参数、配置、存储错误写 JSON error 到 stderr 并退出 1。Node 22 可能同时输出 SQLite 的原生实验性警告。

### 恢复与范围

正常关闭与进程中断都保留 Durable 的受理记录和执行状态。重新打开后可先被动查询，再通过 wait 或 resume 恢复；不要为了恢复编造新请求 ID。请求正文摘要与提交之间存在未确认窗口：若回执未返回，调用方保留原 ID 与正文重试。被中断的模型请求可能重新发送，不承诺外部请求恰好执行一次。

Durable 自动 compaction 保持关闭，模块 3 的 BC 是上下文压缩所有者。本模块没有注册文件、命令或屏幕工具，没有替换旧 Android/Capacitor 运行链路。

### 模块 2 验收

父助手在 Windows / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 143 个端到端检查点及公开类型声明检查。模型服务采用本地可控的 OpenAI completions SSE 服务，未调用付费模型或读取真实模型凭证。

验证覆盖跨进程主私聊、原始历史分页、不同 Bot 上下文隔离、持久模型选择、请求去重与冲突、错误回执、单进程所有权、强制结束进程后的同 ID 恢复、主动停止、关闭后释放所有权，以及已结束等待不启动其他待处理工作。报告与验证数据保存在仓库外，没有新增测试文件；Linux、Android 和外部真实模型服务尚未验收。

## 模块 3：内嵌 Billion Context

Host 使用 [acp-kernel](https://github.com/ranxianglei/acp-kernel) 0.0.101 管理长期上下文，不需要另外启动 bili 或代理。上游负责范围选择、分层压缩、引用、摘要投影与搜索；摘要由模型通过工具提供。完整条款及署名见 [第三方声明](../THIRD_PARTY_NOTICES.md#acp-kernel)。

### 持久状态和请求投影

BC 状态按 Durable conversation 保存，公开 Bot/主私聊身份保持不变。消息身份来自 Durable EntryId 与 entry 内消息下标，不依赖正文哈希或请求数组位置；相同正文的两条消息有不同引用。

每次模型请求前，宿主读取该生成任务 cutoff 对应的历史视图，把 kernel 状态、内容存储和请求投影放在同一次宿主 commit 中。它与随后保存模型回复的 commit 分开。相同逻辑请求的重试/恢复复用持久投影，不重复分配引用、推进块存活次数或追加提醒。缓存值在事务内复制为普通 JSON，不把已结束事务的草稿传给模型。

kernel 的增长/压力决策由宿主渲染为临时上下文提醒；窗口占用估计按已折叠投影计算。原始人类输入不带压缩标签，摘要和提醒不伪装成人类消息写回历史。Durable 自动 compaction 关闭，避免两套压缩策略同时改写上下文。

本模块折叠纯文本 user/assistant 消息。system、thinking、工具调用/结果和图像等复杂内容原样保留并排除折叠，结构化参数与签名不被标签改写；工具结果不进一步卸载，模块 4 保持同一保护。

### 上下文工具

| 工具 | 当前能力 |
| --- | --- |
| `compress` | 复用上游参数 schema 与解析器，提交模型摘要、范围和来源；以 Durable 工具 taskId 持久去重 |
| `decompress` | 按 blockId 内联返回真实原文/嵌套块内容，块保持折叠；当前不支持 toFile |
| `search_context` | 使用上游统一检索入口查询摘要与原始消息，返回引用、来源块、分数与预览 |
| `acp_status` | 查询该 conversation 的压缩状态、引用及窗口估计 |

工具只能使用自身运行中的 conversation 范围，不接受模型自报 Bot/聊天身份。不同 Bot 的 refs 和原文索引分别保存。统一检索沿用上游 hybrid 规则，可返回模糊相似词；结果携带实际来源，原文查找后可按所属 blockId 展开。

### 被动查询与兼容

Runtime 新增 `contextStatus(botId)`，CLI 对应：

```bash
node host-core/runtime-cli.js context --data-root '/path/to/host-data' --bot-id "$BOT_ID"
```

该查询不需要模型配置、不创建会话或启动调度，返回块、refs 与已准备请求的元信息，不返回缓存模型消息全文。未开始的 Bot 返回空状态。

模块 2 旧会话在显式提供 models 的主动打开路径中解除旧 tools:[] 限制，身份和历史保留；被动历史/状态读取不执行该升级。未知 kernel 版本被拒绝，不自动重置或套用当前格式，原始历史仍可读取。

### 模块 3 验收

父助手完成 69 个端到端检查点及公开类型声明检查，使用 Windows / Git Bash、Node 26.8.2 和最低版本 22.19.0，以及本地可控 SSE 模型服务。

验证包括：原文逐条保留、相同正文引用独立、实际请求采用摘要、真实原文展开、摘要与原文检索、Bot 范围隔离、自动提醒进入模型请求但不写原始人类历史，以及进程强杀后复用同一投影。另以 SQLite 故障注入验证：压缩状态已保存但工具回执写入失败，恢复后仍只有原来的摘要块；重复的模型 toolCallId 不会误用其他工具任务的回执。

未知 kernel 状态的主动执行与上下文查询被拒绝且数据库不变，原始历史仍可读。数据和报告保存在仓库外，没有新增测试文件；Linux/Android 和真实外部模型费用尚未验收。

## 模块 4：本机工具

本机工具已接入 Runtime：read/write/edit/bash 来自 pi-durable 的 coding-tools，grep/find/ls 是模块 4 的原生适配（rg/fd/文件 API）。工具在 Bot Host 上执行，cwd 默认位置不是沙盒；运行时不 `process.chdir`，按 conversation+cwd 缓存执行环境，`close()` 时清理环境进程。

### 命令环境

Windows 只在固定 Git 安装目录（ProgramFiles/ProgramFiles(x86)/LOCALAPPDATA 下的 Git/bin 与 Git/usr/bin）寻找 bash.exe，Linux 固定 `/bin/bash`、`/usr/bin/bash`；均不搜索 PATH，也不提供 PowerShell。缺少 bash 只影响 bash 工具，read/write/edit/ls/grep/find 不受影响。`openRuntime` 或运行时配置接受可选 `bashPath`（绝对路径的 bash/bash.exe）与 `toolPaths`（`{rg, fd}` 绝对路径）；仅 undefined 表示未提供，显式 null 与类型错误报 `INVALID_ARGUMENT`，路径存在性在工具实际使用时才检查。

### 搜索二进制定位与准备

grep/find 使用的 rg/fd 按序定位：显式 `toolPaths` -> dataRoot 固定版本安装（`<dataRoot>/tools/<platform>-<arch>/<name>-<version>/`）-> Pi agent bin 目录（PI_AGENT_DIR/bin 与 ~/.pi/agent/bin）-> PATH（Linux 上 fd 额外识别 `fdfind`）。模型调用不会触发下载；只有显式运行安装命令才会下载：

```bash
node host-core/prepare-tools.js --data-root '/path/to/data-root'
```

安装 rg 15.1.0 / fd 10.3.0：使用系统 curl/tar（Windows 优先 System32 的 curl.exe，缺失时回退 PATH 上的 curl；tar 仅用 System32 的 tar.exe，无 PowerShell 回退），从固定官方 GitHub release 下载固定 asset，tar 流式提取固定 entry 到 stdout（不落盘解压），校验 PE/ELF 头；`LICENSE-MIT` entry 随下载保存到安装目录，binary 先写临时文件再原子 rename 发布，返回安装结果含 sha256 指纹。目前仅 Windows x64 上实际运行过资源安装；Linux/arm64 与四平台完整验收未完成。

### 工具边界

- `find`：picomatch 4.0.7 过滤 glob（dot 含隐藏文件、nonegate/strictBrackets、无斜杠模式按基名匹配），fd 以空正则枚举全部文件并负责 gitignore 遍历（`--hidden`、排除 `.git`，非 git 仓库加 `--no-require-git`）；NUL 分帧逐条过滤（`--print0`），每条路径独立校验与匹配。默认 1000 条（上限 10000）：fd 收集 limit+1 条即只取消本次扫描自身进程；输出 50KB、60 秒超时；坏 glob 报 invalid_pattern 错误，目标不存在等非零退出报错。

- `grep`：rg `--json` 流按记录解析，单条 JSON 记录 64KiB 上限，每行按 500 Unicode 码点截断（带 … 标记），可见输出 50KB，默认 100 条匹配（上限 10000），60 秒超时；命中限额/大小界时只取消本次扫描自身的进程。尊重 .gitignore（仓库内外），单文件搜索从其父目录启动。

- `ls`：纯文件 API（环境 `openDirReader`），无外部程序；字母序（大小写不敏感）、含 dotfile、目录加 `/` 后缀、不跟随符号链接、不递归；默认 500 条（上限 10000）、输出 50KB。

### 重放与副作用

工具沿用 Durable 原生安全语义重放，不承诺外部 shell 副作用 exactly-once（bash 已写文件、操作应用或产生外部效果而结果未知时核查或报告不确定）。模块 3 对 system/thinking/工具调用与结果等复杂内容的原文保护继续生效，模块 4 未做进一步的结果卸载。

### 模块 4 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 和最低版本 Node 22.19.0 下完成 33 个模型工具协议场景、168 个端到端检查点及公开类型声明检查，全部通过。模型使用本地可控的 OpenAI completions SSE 服务，未调用付费模型或读取真实模型凭证。

验证覆盖七个工具的实际往返、中文/空格/emoji 路径、Bot 工作目录、文件读写和精确替换、Git Bash、gitignore 仓库边界、Windows 递归 glob 的零层匹配、隐藏文件、Unicode smart-case、坏参数及错误回执。2105 个文件的目录分页、2105 行 find、3000 行 grep、50KiB 输出限额、长行 Unicode 截断、超时终止和可跨关闭读取的完整输出文件均通过。Node 22 清空 PATH 后仍通过完整工具流程；显式缺失程序不影响文件工具，也不静默回退。

资源准备命令已真实下载并安装固定 rg/fd、保存许可证，重复准备结果稳定；导入模块不执行 CLI。错误配置在创建 Host 数据前被拒绝。强制结束进程后，同一 submissionId 恢复完成，中断的 unsafe Bash 返回可能已部分执行的错误信息，已发生的写入没有重放；恢复后仍应按工具回执核对外部副作用。

数据与 module4-verification.json 报告保存在仓库外，没有新增测试文件。Linux、Android、arm64、真实外部模型服务及设备 UI 尚未验收；旧 Android 运行链路未被替换。

## 模块 5：本机控制面（长期 Host 控制 API）

模块 5 为长期运行的本机 Host 增加受认证的控制 API：一个常驻服务进程持有同一个 openRuntime（唯一运行时）与 openHost registry 连接，客户端经回环 HTTP 控制该 Host。本模块只提供基础 HTTP 服务与 Node/浏览器兼容客户端，**没有**实现 SSE、框架隧道、中心或 Tauri 外壳；不要据此宣称这些能力已就绪。

### 服务端

```js
import { openControlServer } from "./host-core/index.js";

const control = await openControlServer({
  dataRoot: "/path/to/data-root",
  token: "…32-512位 URL-safe 不透明字符串…", // 必填
  // port 可选：默认 8787，0 表示系统分配；固定绑定 127.0.0.1
  // models/defaultModel/bashPath/toolPaths 同 openRuntime（模块 2/4）
});
console.log(control.deviceId, control.url);
await control.close(); // 幂等：先关 listener/连接与进行中 handler，再关 runtime、registry
```

- 先校验 token 再打开任何数据；服务只监听回环地址，不暴露给外部网卡。
- 生命周期：每服务一个 openRuntime 加一个 openHost registry 连接（同一 `host.sqlite`，不启动第二个 runtime）；listen 成功后才调用一次 `resume()`。没有任何按请求关闭或客户端断开关闭；`close()` 幂等，任何一步失败仍继续后续清理并最终抛出；优雅关闭保留未完成 Durable 状态，这与 `abort` 是不同的概念。
- 认证：所有请求必须带 `Authorization: Bearer <token>`，token 须匹配 `/^[A-Za-z0-9_-]{32,512}$/`；校验在打开数据前完成，使用 timing-safe 比较。任何携带 `Origin` 头的请求一律拒绝（服务不是开放跨源网页 API；移动 WebView 应用 native fetch 适配，不发送 Origin）。不记录 token，不提供 CORS 通配，不接受 token 查询参数。

### 路由

| 方法与路径 | 请求体 | 成功响应 |
| --- | --- | --- |
| GET `/v1/host` | — | 200 `{protocolVersion:1, deviceId, platform, arch}`（不含 dataRoot/模型凭证） |
| GET `/v1/bots` | — | 200 `BotRecord[]` |
| POST `/v1/bots` | `{requestId, role, cwd, modelRef?}` | 201 `BotRecord`（Host 确认真实 cwd 并去重，注册成功以 Host 回执为准） |
| GET `/v1/bots/:botId` | — | 200 `BotRecord`，否则 404 `BOT_NOT_FOUND` |
| GET `/v1/bot-requests/:requestId` | — | 200 `BotRecord`，否则 404 `BOT_REQUEST_NOT_FOUND` |
| POST `/v1/bots/:botId/submissions` | `{requestId, text}` | 202 `PrimarySubmission`（只受理，决不等待回答） |
| GET `/v1/bots/:botId/submissions/:requestId` | — | 200 `PrimarySubmission`，否则 404 `SUBMISSION_NOT_FOUND` |
| GET `/v1/bots/:botId/history?limit=&cursor=` | — | 200 `HistoryPage`；limit 须为严格正整数十进制数，cursor 须为 JSON 对象 |
| POST `/v1/bots/:botId/abort` | — | 200 `{botId}`；显式停止，客户端断开不是 abort |
| GET `/v1/bots/:botId/context` | — | 200 `ContextStatus` |

错误响应统一为 `{"error":{"code":...,"message":...}}`（不带堆栈、不泄漏 token）。错误码到 HTTP 状态映射：`INVALID_ARGUMENT`/`INVALID_CWD`→400，`REQUEST_CONFLICT`/`MODEL_REQUIRED`/`MODEL_NOT_FOUND`/`RUNTIME_BUSY`→409，`BOT_NOT_FOUND`/`BOT_REQUEST_NOT_FOUND`/`SUBMISSION_NOT_FOUND`→404，`UNSUPPORTED_SCHEMA`→503，其他代码返回 500，并保留已有错误码；没有错误码时使用 `INTERNAL`；另有 `UNAUTHORIZED`→401、`ORIGIN_FORBIDDEN`→403、`REQUEST_TOO_LARGE`→413、`UNSUPPORTED_MEDIA_TYPE`→415、`METHOD_NOT_ALLOWED`→405、`NOT_FOUND`→404。

### 控制 CLI（常驻）

```bash
export CONTROL_TOKEN="$(openssl rand -hex 32)"
node host-core/control-server-cli.js \
  --data-root "$DATA_ROOT" --config "$CONFIG" \
  --token-env CONTROL_TOKEN --port 8787
```

- 必须提供 `--data-root`、`--config`、`--token-env`；`--port` 可选（0..65535）。环境变量名会被校验；配置通过 `loadRuntimeConfig` 显式读取（模型配置见模块 2）。
- 就绪后向 stdout 输出一行 `{"event":"listening","deviceId":...,"url":...}`，随后保持存活；收到 SIGINT/SIGTERM 时关闭一次。
- 服务 CLI 还接受私有 stdin：输入一行 `shutdown` 触发优雅关闭，供本机进程管理使用；EOF 不会停止 Agent，HTTP 没有 shutdown 端点。

### 控制 CLI（命令）

```bash
node host-core/control-cli.js <host|create|list|get|find-request|send|status|history|abort|context> \
  --url http://127.0.0.1:8787 --token-env CONTROL_TOKEN [核心 CLI 风格参数]
```

- `create` 需要 `--request-id --role --cwd [--model-ref]`；`get` 用 `--bot-id`；`find-request` 用 `--request-id`；`send` 用 `--bot-id --request-id --text`；`status` 用 `--bot-id --request-id`；`history` 支持 `--limit --cursor`；`abort`/`context` 用 `--bot-id`。
- `send` **只受理**：输出受理回执一行 JSON，不等待回答；回执为 terminal unanswered 时退出 2。参数/配置/存储错误把 JSON error 写到 stderr 并退出 1。

### 客户端

`@e-launcher/host-core/control-client` 导出 `createControlClient({url, token, fetch?})`，返回与路由表对应的命名方法（getHostInfo/createBot/listBots/getBot/findByRequest/submit/getSubmission/history/abort/contextStatus）。客户端 JS 没有任何 Node 导入，可在浏览器/WebView 使用；可选传入 `fetch` 实现。每个调用可传 `{signal}` 取消；`history` 选项在原 HistoryOptions 上加 `signal`。状态查询是被动的，客户端没有 wait/resume 端点。错误统一为 `ControlApiError`（带 `code`/`status`）：解析 JSON 错误响应，并把网络/协议错误区分清楚；任何情况下不记录 token。

### 边界与安全

- `send` 受理与 `status`/`abort` 分离：断开客户端不会停止 Agent；Host 进程退出只是暂停，重启后经同一长期服务 resume 可恢复，不冒充 abort。
- 只读控制查询现场询问 Host，缓存或离线设备不虚报；Bot 注册成功由目标 Host 确认。
- 模型凭证不进 API，也不进中心；服务没有关闭端点、任意文件读写或其他提权接口。

### 模块 5 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 31 个 HTTP 场景、181 个端到端检查点及公开类型声明检查，全部通过。另在隔离 Chrome 页面实际加载同一纯 JS 客户端，验证协议错误、Origin 拒绝和 AbortSignal 取消。

验证覆盖认证、媒体类型、坏 JSON/UTF-8、1MiB 请求限制、方法与路径、幂等/并发创建、编码请求 ID、历史分页与上下文查询。发送约 140ms 即受理，慢模型不阻塞其他 Bot；客户端退出后推理继续，显式 abort 停止当前及排队输入，并终止命令的后续写入。其他 Bot 的执行不受影响。

存在慢请求体和运行中命令时，私有 stdin shutdown 约 1.1 秒完成优雅关闭并退出 0。Node 22 重启后自动恢复同一 submissionId，原 Host/Bot 身份保留，中断的 unsafe Bash 回执说明可能部分执行，已发生的写入不重放。端口 0、stdin EOF 不停 Host、重复所有者拒绝、CLI 导入无副作用与令牌不回显均通过。

模型使用本地可控 SSE 服务，没有调用真实付费模型或读取真实模型凭证。数据与 module5-verification.json 报告保存在仓库外，没有新增测试文件；Linux、Android、arm64、框架隧道、中心和 Tauri 外壳尚未验收。

## 模块 6：Bot 主私聊实时预览（认证本地 SSE）

模块 6 为模块 5 的控制 API 增加主私聊实时预览：客户端经认证本地 SSE 订阅某 Bot 主私聊的**有界**投影（历史窗口/工具/生成文本/忙碌状态），先拿到完整快照，再接收整体替换式的更新。预览是瞬态进度，不是可靠记录；**原始历史 API 仍是完整事实源**，分页读取不受影响。

**没有**群消息传输、中心或 Tauri 外壳，也没有轮询或新调度器；不要据此宣称这些能力已就绪。

### 服务端路由

| 方法与路径 | 成功响应 |
| --- | --- |
| GET `/v1/bots/:botId/live` | 200 SSE（`event: bot-live`，`data: <JSON frame>`，空行分隔）；帧见下表 |

SSE 与现有路由共用 Bearer 认证；不接受查询参数令牌，不改变 CORS/Origin 规则。`serveBotLive` handler 在流结束后才 resolve，由既有 inflight 追踪与服务关闭统一收尾；只在 SSE 响应上设置无限超时与可选心跳，不改 JSON 路由的服务器超时。

帧公共部分为 `{type, botId, conversationId, sequence}`；`conversationId` 恒为该 Bot 的公开主私聊 UUID（即使 SDK conversation 尚不存在）。`sequence` 在每个订阅内单调递增，可跳号/合并，是投影修订版本号，**不是**持久游标或 ACK。

| type | 字段 | 语义 |
| --- | --- | --- |
| snapshot | `state: BotLiveState` | 每个订阅最先异步交付一次完整快照；重连从新 sequence 和全新有界快照开始 |
| update | `changes: Partial<BotLiveState>` | 变更字段是整体替换（含历史窗口整窗替换），不是追加/增量 |
| end | `reason` | 仅传输层；连接可能在其写出前结束，尽力投递 |

### 运行时 watch

`Runtime.watch(botId, {signal?})` 返回 `BotWatch`：

| 成员 | 语义 |
| --- | --- |
| `value` | 最新完整 `BotLiveSnapshot`（用于 SSE 背压重置） |
| `start(listener)` | 先异步投递快照，再串行交付更新；慢监听器只保留最新状态。内部原生观察回调仅投影/入队，不调用 Session API 或 commit |
| `stop()` | 取消观察者，返回 `BotWatchEnd`；不等待用户回调完成 |
| `closed` | 观察终止的 Promise（`BotWatchEnd`） |

实现使用公共 `Conversation.watch`（BACKGROUND_CONTEXT 派生的取消上下文），投影 Durable 约 100ms 提交的部分消息/工具，**不是** provider 的每个 token；无 subscribeCommits、TaskGraph 内存或 watchDoc 轮询。

**订阅是被动的**：不创建/启动模型会话。新 Bot（或尚无 Durable 会话）返回空快照并保持挂起，绝不创建或启动模型；`Runtime.submit` 在主私聊解析/创建后绑定挂起订阅，再提交输入。每个订阅只附着一次底层 watch；subscribe/bind/stop 竞争幂等处理。

### 有界预览界限

投影有明确上限并置截断标记：

- 历史窗口：最新 50 条可显示条目；每条最多 8 条消息；每条消息 ≤ 4096 UTF-16 单元；全窗口文本总量 ≤ 65536 UTF-16 单元（超出时丢弃最旧整条目）。
- 生成文本 ≤ 32768 UTF-16 单元。
- 工具：前 32 个；每个工具输出尾部 ≤ 4096 UTF-16 单元。
- 省略 system/未知角色及所有非文本部分（参数/签名等）；`droppedBytes`/`droppedLines` 透出丢弃量。

需要完整原文请使用既有 `history` 分页接口；预览窗口与完整历史互不影响。

### 客户端与 CLI

`ControlClient.live(botId, {signal?})` 返回 `AsyncIterable<BotLiveFrame>`，纯 JS 无 Node 导入，浏览器/WebView 可用（native fetch 适配，不发送 Origin）。解析按 SSE 语法（LF/CRLF、注释、多行 data、TextDecoder 流式、单帧上限 1MiB、忽略心跳），校验帧信封（已知类型、botId 匹配、非空公开 conversationId、安全非负 sequence、snapshot.state/update.changes 为对象、end.reason）；HTTP 错误信封仍是 `ControlApiError`。`return`/`break`/`abort` 只取消读取与连接，不发 abort API；意外 EOF/网络/协议错误抛出明确错误，显式 end 正常结束；不自动重连/轮询。

```bash
node host-core/control-cli.js live --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID"
```

`live` 与其它单结果命令不同：每个帧输出一行 JSON；SIGINT/SIGTERM 或 stdout EPIPE 只停止该流并以正常码退出；stdout 背压用标准 drain+signal 处理。

### 断开与恢复边界

- 客户端断开只 `watch.stop()`，不会 `runtime.abort()`：Agent 继续运行。
- Host 进程退出只是暂停，重启后经长期服务 `resume()` 恢复，不能冒充 abort；end 帧尽力而为。
- 服务端背压：`res.write` 返回 false 后停止写新更新；只有实际跳过更新时才记 needReset，`drain` 时补最新 `watch.value` 完整快照。已被接受的帧不会因 drain 重复发送，空闲的大快照也不会反复发送。
- 不承诺瞬态进度的可靠投递；预览丢失以新快照重建，完整历史仍可分页读取。

### 模块 6 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 与 Node 22.19.0 下完成 124 个端到端检查点，全部通过；公开类型声明检查通过。隔离 Chrome 页面加载实际纯 JS 客户端，并通过真实 HTTP SSE 夹具验证 LF/CRLF、多行 data、UTF-8、大小限制、身份与修订顺序、错误信封和取消。

实际订阅验证了新 Bot 空快照且 Durable 表计数不变、首次发送绑定多个订阅、已有历史快照、工具 pending/running/done 与中途输出、排队与显式停止。CLI 的 stdout EPIPE 正常退出后，Agent 仍完成写文件。使用本机 OpenSSL TLS 服务分三次发送模型 SSE，分别收到两次已提交部分回复和完整终态；Node 22 的 40006 单元原始回答仅把生成预览截到 32768 单元。

长历史触发 50 条及 65536 单元窗口限制，原始历史保持完整；真实 40 次工具调用仅预览前 32 个，工具输出尾部截到 4096 单元。慢客户端收到合并及重置快照，最后恢复到最新空闲状态；66989 字节空闲快照只发送一次，没有 drain 循环。空闲流跨过 30 秒并收到两次心跳。

关闭时存在 SSE 订阅及快速断连请求，Node 22 服务约 1.1 秒退出 0，随后重新打开同一数据目录成功，设备及主私聊身份保留。数据、协议夹具与 module6-verification.json 保存在仓库外，没有新增测试文件，也没有调用外部模型或读取真实凭证。

Linux、Android、arm64、Tauri/TUI 和真实终端信号尚未验收。Runtime.watch 的直接慢监听器、故障及取消竞争仅作源码核对，实际端到端验收经过 HTTP/CLI 订阅路径；本模块未实现可靠群消息、跨设备隧道或中心。

## 模块 7：本机持久消息账本（messages.sqlite 与特权离线 CLI）

模块 7 在 Host 本机实现持久消息账本：作用域/成员修订、不可变信封、outbox、接收落地去重与 ACK、本地收件/历史/缺口，以及特权离线 CLI。**只**存储与在本机记账；**没有**网络认证/隧道/HTTP 入口/中心/LLM 调用/推理/唤醒/UI。不要据此宣称跨设备消息已收发，或任何网络能力已就绪。

- 新数据库为 `dataRoot/messages.sqlite`（user_version=1，FK ON，busy_timeout 5000，BEGIN IMMEDIATE 事务）；`host.sqlite` v1 与 `durable.sqlite` 保持不变，旧 Android 数据与 Durable 不动。
- `openMessageLog({dataRoot})` 同步返回 `MessageLog`（`{deviceId, dataRoot, installScope, getScope, listScopes, publish, getMessage, receive, acknowledge, history, inbox, outbox, deliveryStatus, streamStatus, close}`），并同时打开既有 openHost registry 连接；不触发 runtime/harness/model 调用。close 幂等；打开失败关闭已打开部分。

```js
import { openMessageLog } from './host-core/index.js';

const log = openMessageLog({ dataRoot: '/path/to/data-root' });
try {
  const scope = log.installScope({
    scopeId: 'room-1', kind: 'room', revision: 1,
    members: [
      { deviceId: log.deviceId, botId: process.env.LOCAL_BOT_ID },
      { deviceId: process.env.REMOTE_DEVICE_ID, botId: process.env.REMOTE_BOT_ID },
    ],
  });
  const stored = log.publish({
    messageId: 'm-1', scopeId: 'room-1', author: { kind: 'user' },
    category: 'public', text: '你好',
  });
  log.history('room-1', { limit: 50 });
} finally {
  log.close();
}
```

示例的 `LOCAL_BOT_ID` 必须是本机已登记 Bot；另外两个环境变量提供已确认的远端设备与 Bot 标识，登记此定义不会查询远端是否在线。

### 作用域与成员

- `MessageScope` 成员只能是 Bot（`{deviceId, botId}`）；`dm` 恰 2 个不同 Bot（可同机），`room` 2..64；成员按 deviceId 再 botId 确定性排序（JS code-unit，非 localeCompare）。
- 修订不可变，kind 不变。DM 的两个参与者固定，换一对 Bot 必须创建不同 scopeId。群首次安装需至少一个本机成员，后续修订可移除本机成员并保留旧历史。相同修订重试返回同一 Scope；同 scope/rev 不同定义报 `REQUEST_CONFLICT`。
- 隐式人类 owner 只能经至少有一个成员 Bot 的 Host 发布到 room；人类作者显式为 `{kind:'user'}`，仅 room 的 public 消息；bot 间 DM 不允许 user actor。未来模型工具必须注入自己的 bot actor，本机控制 UI 注入 user，不信任意模型自报作者。

### 信封、流与目标快照

- 每个源流按 (scopeId, revision, sourceDeviceId) 区分，`streamId='scope:'+sha256(JSON.stringify([scopeId, revision]))`；成员修订变化即开启新流，新成员不会因从未面向它的事件产生假缺口。
- `envelope.targets` 是**整份规范成员列表**（冻结的 targetSnapshot），随消息一并固定，不由调用方选择；规范属性按 normalizeEnvelope 固定顺序构造。
- digest 为规范化信封 JSON 的 SHA256 小写 hex；完整规范化 publish 请求摘要单独保存用于幂等重试（排除生成字段）。
- 标识最多 256 UTF-8 字节、正文最多 262144 字节；保留原始空白及 Unicode 拼写，拒绝空白正文和孤立 UTF-16 代理字符，防止 SQLite 编码转换造成身份碰撞。时间戳须是有效的毫秒 UTC ISO 字符串。

### publish / receive / ack

- `publish`：已有 messageId 且相同发布指纹时在任何最新作用域检查前返回原消息（重试安全）；指纹不匹配或与已接收 ID 冲突报 `REQUEST_CONFLICT`。replyTo 须引用同作用域已存消息（可为旧修订）；rootId 从 parent.rootId 派生，无 parent 时为 messageId；user 作者即使给 replyTo 也始终以 messageId 为 rootId。room 仅 public；dm 仅 notice/request/reply，reply 必带 replyTo。本地 DM 无远程 outbox。
- `receive`：要求 `peer.deviceId===envelope.sourceDeviceId`、修订已安装、targets 恰为规范存储成员、Bot 作者属于该修订的源 Host 成员（user 源需源 Host 有成员 Bot 且类别 public）、本机目标成员均存在。未知修订拒绝且不发 ACK；不猜名单/中心目录。同 ID 同 digest 返回原始条目与稳定 ACK，绝不重复本地目标；同 ID 异 digest 或 source+stream+seq 被他 ID 复用报 `REQUEST_CONFLICT`。
- `acknowledge`：仅当 peer.deviceId===ack.recipientDeviceId、ack.sourceDeviceId===本机、本机原消息+目标 outbox 存在且 digest 匹配。pending→acked 置 acked_at；重复 ACK 无状态变化/新事件。**ACK 是投递层确认，不是聊天消息**，不进收件/历史。
- 落盘与推理分离：inbox/已落盘 = 纯回执，不等于已推理；没有自动响应或请求合成。

### history / inbox / outbox / delivery / stream

- `history` 按本机 `local_id` 升序（Host 接收顺序，非全局时间线）分页；`MessageCursor {deviceId, kind:'history', key:scopeId, afterLocalId}`，仅限本机/同 scope；每页 `streams` 只含本页条目代表的流状态。`missingRefs` 在读取时计算，晚期补到引用可在不改原信封下消缺。
- `inbox(botId, {scopeId?, limit?, cursor?})` 含本机源副本（`selfEcho` 标记），纯回执、非推理。模块 10 增加可选 `scopeId`：SQL 使用现有 `(scope_id, local_id)` 范围索引限定扫描，并用冻结本机 Bot 目标的 `EXISTS` 在分页前过滤，不先读全局 inbox 再在 JS 过滤；涵盖全部修订，不按当前成员名单剔除旧目标记录，不新增 schema/索引迁移。
- inbox 游标仍为 `MessageCursor`：不传 scope 时 `key=botId`，保留旧调用；传 scope 时 `key='scope:'+sha256(JSON.stringify([botId, scopeId]))`。旧全量/新 scoped 游标以及不同 Bot/scope 的游标不可混用；仍返回 `selfEcho` 与读取时计算的 `missingRefs`。
- `outbox` 只返回 PENDING，`{targetDeviceId, message}` 重试用同一稳定信封；按 local_id 再 target_device_id 排序。
- `deliveryStatus` 只针对本机源消息；收到的消息报 `SCOPE_FORBIDDEN`，未知报 `MESSAGE_NOT_FOUND`；聚合唯一 Host 目标（非 Bot），状态 stored/pending/acked + acknowledgedAt。
- `streamStatus` 的 gaps 只到已观测最高序号，不虚构尾部/补洞；最多 100 个最早缺口区间并置 gapsTruncated；SQL LAG/相邻行索引区间实现，绝不循环 1..highest。
- 分页 limit 默认 50、上限 200；cursor 跨设备/kind/key、字段类型错或未知字段拒绝。

### 错误码

`INVALID_ARGUMENT`、`REQUEST_CONFLICT`、`UNSUPPORTED_SCHEMA`、`BOT_NOT_FOUND`、`SCOPE_NOT_FOUND`（含缺修订）、`MESSAGE_NOT_FOUND`、`DELIVERY_NOT_FOUND`、`SCOPE_FORBIDDEN`、`PEER_MISMATCH`。错误不带堆栈/token。

### CLI（特权离线）

```bash
node host-core/message-cli.js scope --data-root "$DATA_ROOT" --input scope.json
node host-core/message-cli.js scopes --data-root "$DATA_ROOT"
node host-core/message-cli.js get-scope --data-root "$DATA_ROOT" --scope-id room-1 --revision 1
node host-core/message-cli.js publish --data-root "$DATA_ROOT" --input publish.json
node host-core/message-cli.js get --data-root "$DATA_ROOT" --message-id m-1
node host-core/message-cli.js receive --data-root "$DATA_ROOT" --peer-device-id dev-a --input envelope.json
node host-core/message-cli.js ack --data-root "$DATA_ROOT" --peer-device-id dev-a --input ack.json
node host-core/message-cli.js history --data-root "$DATA_ROOT" --scope-id room-1 --limit 50
node host-core/message-cli.js inbox --data-root "$DATA_ROOT" --bot-id "$LOCAL_BOT_ID" --limit 50
# 模块 10：可选范围过滤，旧的不带 --scope-id 调用保持原语义
node host-core/message-cli.js inbox --data-root "$DATA_ROOT" --bot-id "$LOCAL_BOT_ID" --scope-id room-1 --limit 50
node host-core/message-cli.js outbox --data-root "$DATA_ROOT" --scope-id room-1 --limit 50
node host-core/message-cli.js delivery --data-root "$DATA_ROOT" --message-id m-1
node host-core/message-cli.js stream --data-root "$DATA_ROOT" --scope-id room-1 --revision 1 --source-device-id dev-a
```

- 全部命令要求 `--data-root`（除 help）；scope/publish/receive/ack 输入 JSON 文件 ≤1MiB，绝不 stdin；游标是 JSON 对象；未知/缺失/无关选项拒绝。
- receive/ack 是**特权离线适配器**接口：peer 由可信进程内调用方断言，**不是**密码学认证实现，也不是模型选项；无 `--force` 信任绕过，无自动投递/重试/轮询/LLM。
- stdout 一条 JSON；应用错误以 `{"error":{"code":...,"message":...}}` 输出到 stderr，exitCode=1，finally 关闭消息库与 registry，清理失败保留工作错误。

### 边界与验收

- 模块 7 不改当前 token 路由；模块 5/6 的主私聊认证本地 SSE 仍是主私聊通道。
- 父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 **278 个端到端检查点**及公开类型声明检查，全部通过。使用四份独立 Host 数据目录，经特权离线 CLI 传递信封；没有把此过程当作网络认证或真实跨设备传输验收。
- 验证涵盖人类/Bot 作者分离、群与 DM、同机投递、乱序接收、引用补齐、成员变更、旧目标保留、新成员流、去重 ACK、离线待投递和绑定 Host/范围的分页游标。8 个进程并发创建/提交/接收/确认同一项时只保存一次；12 个不同消息并发提交后，序号连续。
- SQLite 触发器故障注入验证消息/outbox、本地收件和 ACK 的事务回滚；失败受理无半条消息、无 ACK，重试不跳过序号。102 个稀疏序号的缺口截到 100 区间并标记截断；最高安全整数 9007199254740991 的接收与查询在本次机器上分别约 117ms / 135ms，没有按整数范围循环。
- 256 字节标识与 262144 字节正文边界、UTF-8/日期、错作者/目标/摘要/来源、SQL 特殊字符、坏文件与参数均经过实跑。未知/更高版本/损坏/错设备消息库被拒绝，文件哈希保持原样；新账本打开前后既有 Host/Durable/owner 数据库哈希相同。Node 22 写入、Node 26 重放与旧主私聊查询通过，当前 HTTP 控制面没有新增 peer ingress。
- 数据、故障夹具与 `module7-verification.json` 报告在仓库外，没有新增测试文件。Linux、Android、arm64 尚未验收；没有执行 SQLite 提交期间强杀，回滚以实际 SQL 故障注入验证；仅适用于直接 JavaScript 调用的额外选项类型分支做了源码核对，端到端验收使用 CLI。

## 模块 8：认证设备中继与 Host 消息投递（relay + device-link）

模块 8 实现轻中心的第一阶段：**认证设备中继**（relay 服务，只保存设备注册）与 **Host 消息投递**（device-link 客户端，复用模块 7 持久 outbox）。真实的本机进程网络端到端投递已实现；跨设备部署与网络形态尚需真机/外网验收。仍**没有** LLM、群决策、UI、远程控制 RPC；中心没有全局 Bot 目录、聊天库、模型凭证，也不提供通用 URL/端口/VPN 转发。

### 安全与信任边界

- **注册是特权显式动作**：本地所有者把目标 Host 已有 `deviceId` 与独立 opaque 设备 token 写入中心 registry（唯一写入口是 `relay-registry-cli.js`）。没有未认证注册端点，不自动生成新设备 ID，也没有自助配对 UI。设备 token 只从环境变量读取，不是控制 token，不会被记录或持久化明文。
- **中心只存注册**：`relay.sqlite` 只有 device_id、token_hash（SHA256）、credential_version、created_at、updated_at、revoked_at；没有 Bot/历史/作用域表，也没有稳定中心 Host 身份。
- **TLS 注入权威**：接收端通过“连接到已认证所有者 relay 的 TLS 通道”获得 fromDeviceId；没有端到端加密签名/PKI 声明。Host 只信任 relay 注入的 fromDeviceId（不是消息 JSON 或本地控制 bearer）。
- **Hello 先于一切**：首个 JSON 文本帧必须在 5000ms 内为 `{type:'hello',protocolVersion:1,deviceId,token}`；ready 只在认证后发送。WS upgrade 携带 Origin 拒绝 403；路径不是 `/v1/link` 或含 query 拒绝 404；无 URL token/userinfo/fragment，不跟随重定向。
- **loopback 与 TLS**：监听只允许字面 `127.0.0.1`/`::1` 免 TLS；其他监听地址必须提供 TLS cert/key。客户端仅字面回环 URL 可用 ws，非回环必须 wss；自签证书可经 `ca` PEM 传入，但绝不关闭校验（无 rejectUnauthorized:false / insecure 开关）。
- **替换与吊销**：最新成功认证的连接替换旧连接（旧连接收到 4409 REPLACED 即进入 blocked，不再自动重连对抗）。registry 变更递增 credentialVersion；服务端在**每个已认证接收帧**与 **1000ms 定时器**上重查版本/启用状态，失效立即关闭 4403——覆盖另一进程用 CLI 修改 registry 的情况。

### 交付与缓存语义

- **ready ≠ 落盘 ACK**：relay 的 ready 只表示认证/传输就绪；消息确认始终是接收 Host 落盘后的 per-Host ACK。离线/未知 peer 目标的 source pending 保留，不改动、不删除，也不伪造 ACK。
- **扫描是投递，不是模型调度**：`createMessageDelivery` 在线时按 1000ms 定时器 + wake 合并扫描模块 7 outbox（每 tick 一页 200 条，cursor 推进防止永久饥饿），每目标至多 1 条、全局至多 16 条在途；匹配失败按 1000→30000ms 指数退避重试。它从不启动模型、创建输入、调用 log.installScope/SQL，也不改信封（ID/正文/修订/targets）。
- **缓冲有限**：单帧上限 2MiB，高水位 4MiB；目标 `bufferedAmount + frameBytes > 4MiB` 时中心发 `unavailable`（BACKPRESSURE）且不入队。
- **诊断有限**：`lastProblem` 只是最新一条诊断（code/target/messageId/at），不代表全部目标状态；实际事实源仍是 `MessageLog.deliveryStatus`/outbox。

### 可执行流程（现有 deviceId → 所有者注册 → TLS 中继 → Host 链路）

```bash
CENTRE_ROOT='/path/to/relay-data'      # 中心数据目录（relay.sqlite 所在）
HOST_ROOT='/path/to/host-data'         # Host 数据目录（host.sqlite / messages.sqlite 所在）

# 1) 取 Host 现有 deviceId（模块 1 init 输出 {deviceId, dataRoot}）
node host-core/cli.js init --data-root "$HOST_ROOT"

# 2) 所有者预登记：独立设备 token 只经环境变量传入（有效格式 ^[A-Za-z0-9_-]{32,512}$）
export DEVICE_ID='<第 1 步输出的 deviceId>'
export RELAY_DEVICE_TOKEN="$(openssl rand -hex 32)"
node host-core/relay-registry-cli.js register --data-root "$CENTRE_ROOT" \
  --device-id "$DEVICE_ID" --token-env RELAY_DEVICE_TOKEN
# stdout: {"deviceId":...,"credentialVersion":1,"createdAt":...,"updatedAt":...,"revokedAt":null}

# 3) 启动 TLS 中继（非回环监听必须 TLS；本地调试可省略 --listen-host 使用默认 127.0.0.1）
node host-core/relay-server-cli.js --data-root "$CENTRE_ROOT" \
  --listen-host 0.0.0.0 --port 8790 \
  --tls-cert /path/to/server.crt --tls-key /path/to/server.key
# stdout 一行: {"event":"listening","url":"wss://…/v1/link"}

# 4) 启动 Host 链路（token 仍只从环境读；自签 CA 加 --ca，禁止关闭校验）
node host-core/device-link-cli.js --data-root "$HOST_ROOT" \
  --url 'wss://…/v1/link' --token-env RELAY_DEVICE_TOKEN \
  --ca /path/to/ca.pem
# stdout 仅在状态变化时输出一行 {"event":"link_status",...DeviceLinkStatus}
```

注意：`--url` 必须精确到 `/v1/link` 且无 query/fragment；CLI 的 token 永不作为命令行值/stdout/JSON 输出。若 relay 服务仅监听 127.0.0.1（免 TLS），第 4 步改为 `--url ws://127.0.0.1:8790/v1/link` 且不传 `--ca`。

### JS API（`./host-core/index.js` 新增导出）

```js
import { readFileSync } from 'node:fs';
import { openRelayRegistry, openRelayServer, openDeviceLink } from './host-core/index.js';

const { CENTRE_ROOT, HOST_ROOT, DEVICE_ID, RELAY_DEVICE_TOKEN, TLS_CERT, TLS_KEY } = process.env;
const cert = readFileSync(TLS_CERT, 'utf8');
const key = readFileSync(TLS_KEY, 'utf8');
const registry = openRelayRegistry({ dataRoot: CENTRE_ROOT });
try {
  registry.register({ deviceId: DEVICE_ID, token: RELAY_DEVICE_TOKEN });
} finally {
  registry.close();
}

const relay = await openRelayServer({ dataRoot: CENTRE_ROOT, port: 8790,
  listenHost: '127.0.0.1', tls: { cert, key } });
const link = await openDeviceLink({ dataRoot: HOST_ROOT,
  url: relay.url, token: RELAY_DEVICE_TOKEN, ca: cert,
  onStatus: (s) => console.log(s.phase, s.attempt, s.lastError, s.delivery) });
// openDeviceLink 只完成本机资源准备；认证成功后才报告 online。
link.wake();
process.once('SIGINT', async () => {
  await link.close();
  await relay.close();
});
```

### 模块 8 验收状态

父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 **146 个端到端检查点**及公开类型声明检查，全部通过。使用独立 Host/中继进程的真实 WebSocket 和 CA 校验 TLS 连接，包含 IPv4、IPv6 回环及系统分配端口；Node 22 新发消息、路由、接收和确认均已实跑。

验收覆盖群/DM 信封、人类作者保留、离线补投、未知修订拒绝后补装、错误凭证、伪造来源/ACK、认证前业务帧、重复 hello、Origin/路径/query 限制、UTF-8/二进制/帧大小错误。真实发送约 780KiB 的合法转义 JSON 消息并核对接收摘要；读取端未确认时，源 outbox 保持 pending。中继数据库只含 relay_devices，日志及数据库检查未发现测试正文、Bot ID、明文设备令牌或原始 SQL 错误。

凭证轮换/撤销会关闭旧连接，旧进程以 blocked/exit 2 停止，不反复重连；相同设备的新认证连接接管路由，旧连接关闭不会删掉新路由。ACK 写入故障保留在途及 pending，强杀来源进程后恢复补投，接收方仍只有原条目和原 storedAt。强杀中继期间新消息留在 Host，重启中继后完成投递。

大消息向 20 个离线目标发送时观察到发送缓冲拒绝，最高在途数为 6，20 项仍持久 pending。stdin EOF 不停止连接；慢 HTTP 头、未认证 WebSocket 和活连接并存时，中继约 1.1 秒关闭并退出 0。消息链路和原 Runtime 使用不同独占锁，可同时运行，分别关闭。ws MIT 许可证与已安装上游文本一致。

数据、网络夹具与 module8-verification.json 报告保存在仓库外，没有新增测试文件。跨物理设备/外网、Linux、Android、arm64 仍待验证；中继慢接收者的 BACKPRESSURE 分支尚无有效实跑证据，256 连接上限未做负载验收。直接 JS 的 getStatus/回调故障分支做了源码核对，端到端验收主要通过生产 CLI。现有信任模型是受信中继与 TLS 通道，没有端到端消息加密或签名。

## 模块 9：认证远程 Host JSON 控制（已完成父助手验收）

模块 9 在模块 8 的认证中继之上增加固定 10 个 JSON 方法的远程 Host 控制：`getHostInfo`/`listBots`/`createBot`/`getBot`/`findByRequest`/`submit`/`getSubmission`/`history`/`abort`/`contextStatus`。控制与消息是分离的不同角色流量：Host 连接沿用 `device-link`（若有 `--control-url` + `--control-token-env` 配对配置则发送 `role:'host',controlProtocol:1` hello），客户端用 `remote-control-client` 显式发送 `role:'client'` hello。**本模块已完成父助手的本机独立进程端到端验收**，具体环境、覆盖及未实测范围见下文，不代表跨物理设备或全端产品已完成。

### CLI

```bash
node host-core/remote-control-cli.js listBots \
  --device-id <SOURCE_DEVICE_ID> --target-device-id <TARGET_DEVICE_ID> \
  --url 'wss://…/v1/link' --token-env REMOTE_CONTROL_TOKEN \
  [--input control-input.json] [--ca /path/to/ca.pem]
```

- METHOD 必须精确等于上述 10 个方法名之一，无别名；`--input` 可选，缺省 `{}`，为 ≤1MiB 的普通 UTF-8 JSON 对象。
- 成功：stdout 输出一行原始 JSON 结果，exit 0。失败：stderr 输出 `{"error":{"code":...,"message":...,"outcome":...}}`；unconfirmed 结果 exit 2，其他错误 exit 1，`--help` exit 0。信号只关闭客户端，绝不发送 abort 方法；错误输出不含令牌/调用负载。

### JS API（`./host-core/index.js` 新增导出）

```js
import { openRemoteControl } from './host-core/index.js';

const ctl = await openRemoteControl({
  deviceId: DEVICE_ID,            // 本机已注册设备身份
  url: relay.url,                  // ws(s)://…/v1/link
  token: REMOTE_CONTROL_TOKEN,     // relay 凭证（环境变量）
  // ca: cert,                    // 自签 CA，禁止关闭校验
});
try {
  const info = await ctl.call(TARGET_DEVICE_ID, 'getHostInfo', {});
  const bots = await ctl.call(TARGET_DEVICE_ID, 'listBots', {});
  // createBot/submit 等 10 个方法同构；每调用独立 callId
} finally {
  ctl.close();
}
```

### 语义边界

- **同一设备多客户端共存**：多个 `role:'client'` 连接可同时存在；DeviceLink 仍是唯一主机连接。凭证撤销、轮换检查和心跳覆盖全部认证 host/client 连接；新的 Host 连接只替换同设备的旧 Host 连接，客户端可继续共存。新建客户端不打开 host.sqlite/messages.sqlite/device-link-owner 或 Runtime，原 Host 仍是 cwd 创建、推理、工具与历史的唯一权威。
- **令牌区分**：relay 凭证（`--token-env`）用于登录中继；`--control-url`/`--control-token-env` 是本机回环 Control API 的本地令牌（仅字面 `http://127.0.0.1` 或 `http://[::1]`，路径必须 `/`，不带 query/fragment）。
- **信任模型**：传输仍依赖受信中继 + TLS 通道，不是端到端加密/签名；CA 可用但不能关闭校验。
- **结果语义**：`not-sent` 未交给目标本地 Control API；`unconfirmed` 操作可能已被接受（超时/断线/取消后），不可认定无副作用；`responded` 目标本地 API 已返回（未必代表失败零副作用）。应用层请求幂等依赖显式 requestId 重试核对，不自动重试。
- **上限**：请求参数与结果 JSON 各 ≤1MiB（UTF-8），整 relay 帧 ≤2MiB；客户端 8 个在途调用、25s 超时，Host 8 个活动调用、20s TTL，全局 128 条 pending。
- **边界**：仅 Node 客户端；SSE 直播、设备目录/枚举 UI、任意 URL/路径/头/端口 RPC、离线信箱或自动变更重试不在本模块。

### 模块 9 验收

父助手在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下，使用本机独立客户端、中继与 Host 进程及真实 CA 校验的 WSS，完成 **171/171 个端到端检查点**（失败 0），公开类型声明检查通过。IPv6 仅实测回环 ws 认证与目标离线回执，没有据此宣称 IPv6 在线 Host 控制已验收。这里的端到端指业务链路，仍依赖可信中继与 TLS，**不是端到端消息密码学**，没有 E2E 消息加密或签名。

模型服务使用 **Mockoon OpenAI-compatible SSE**，不是外部真实付费模型；目标 Host 实际运行 Durable/BC 及原生 write/bash/grep，确认工具在目标 cwd 执行并写入真实文件。固定 10 个 JSON 方法、同设备多客户端、幂等与并发创建、目标 cwd 校验、逐 call 本机 Host 身份核对、被动历史/上下文查询、离线拒绝且不重放均通过。提交不等待模型，客户端退出后推理继续；忙时输入排队，显式 abort 停止当前及排队输入并阻止后续工具写入。

验收还覆盖调用/连接范围隔离、错误 Host 与重复/迟到回复忽略、更换 Host 后的 unconfirmed、每客户端和每 Host 各 8 个并发上限、20s 中继超时及取消通知、1MiB JSON 边界与超大结果拒绝。RPC 取消不会调用 Agent abort，推理仍可完成；只有显式 abort 才停止 Agent。错误角色/参数/凭证、撤销/轮换、Node 22 中继重启与 Host 重连、Runtime 重开及既有提交稳定、旧消息 outbox/ACK 兼容均已实跑。

29 个日志/数据库文件未含验收用私有标记，中心只持久保存设备注册，三份 Host 数据库完整性通过。所有验收进程已退出：6 个最终核心进程 exit 0，测试模型服务以 SIGTERM/143 结束；只清理本轮验收所属进程。验收数据、脚本、协议夹具及 `module9-verification.json` 报告均保存在仓库外，没有新增仓库内测试文件，也不在文档中保存临时凭据。

未实测范围仍保留：

- 跨物理设备/外网、Linux、Android、arm64、Tauri/TUI，以及真实外部付费模型。
- 全局 128 pending、256 连接上限的负载，以及中继慢接收者反压。
- 直接 JS AbortSignal、客户端本地 25s 超时兜底、恶意服务端同一 chunk 合并帧拒绝等分支仅由父助手源码核对；实际运行覆盖的是生产 CLI/中继取消和 20s 截止路径。

## 模块 10：群与 Bot DM 的独立工作上下文（已完成父助手验收）

模块 10 已完成下述受限范围的本机独立进程端到端验收。它只把已落盘、面向本机 Bot 的事件显式导入隔离的 Durable 工作上下文，不进行工作上下文推理、群决策、通信发送或长期事实记忆；完成本模块不代表自然群聊或全端产品已完成。

### 收件、导入、推理是三个阶段

| 阶段 | 含义 |
| --- | --- |
| 已收件 | 模块 7/8 已将信封落入 `messages.sqlite`，接收去重后可给出投递 ACK；不代表工作上下文已导入 |
| 已导入 | 显式 `syncWorkContext` 把一页事件与导入水位原子写入 `durable.sqlite`；`importedCount` 仅是该上下文累计导入条数 |
| 已推理 | 模型实际处理输入；模块 10 不触发这个阶段，不能从 ACK、水位或导入计数推断 |

- 每个本机 `(botId, scopeId)` 绑定独立、稳定的公开 conversation UUID，内部索引用 `JSON.stringify([botId, scopeId])`，不包含成员 revision。群成员修订沿用原上下文；DM 仍遵守固定双方的模块 7 约束。
- 每个绑定新建 ownerless Durable conversation 与空 BC 状态，不 fork 主私聊、不复制主私聊/其他群/其他 Bot 的历史。同一事件面向多个本机 Bot 时，各自拥有不同 conversation UUID、BC 文档和导入水位。
- 继承本机工具注册与执行环境配置，使用该 Bot 的 cwd、角色及固定的可信“外部事件是数据”说明；不把事件正文插入 system instructions，也不选择、解析或默认绑定模型。导入不执行工具。
- 导入只通过公共 `Tx.appendEntry` 追加模型可见的原始条目；不调用 `Conversation.submit`（包括 write 提交）、wait/resume/startRun，不创建推理任务或自动扫描循环。即使常驻 Host 的调度器已 resume，显式导入也不应产生模型请求。
- BC 按 conversation 独立初始化，但导入不调用 `manager.prepare`，不生成摘要/压缩投影或伪造窗口状态；refs、blocks、prepared 仍按既有 BC 的惰性准备语义管理。初始化 BC 不等于已经压缩。

### 可见性与原子导入

工作上下文操作要求 Bot 属于本机、scope 已存在，并满足其一：当前成员包含该 deviceId+botId；已有该 Bot/scope 绑定；或 scoped inbox 中存在曾冻结面向它的收件。否则分别返回 `BOT_NOT_FOUND`、`SCOPE_NOT_FOUND`、`SCOPE_FORBIDDEN`。退群 Bot 仍可读取原绑定并导入后来才收到的旧目标事件；无权获得退群后的新成员事件，也不能使用 scope-wide history 或另一 Bot 的收件代替自己的 inbox。

一次 sync 只在**同一个串行 Durable commit 内**重查/创建绑定、读当前水位、从独立消息库连接读取一页 scoped inbox、追加全部新条目并更新水位/计数。水位按本机接收 `localId` 推进，不按源序号、修订或时间戳跳过迟到事件。初始水位为 0 时省略源游标；正水位才构造绑定同一 Bot/scope 的 inbox 游标。

绑定、BC 初始状态、原始 Entries 与水位共同提交或回滚，不存在半页导入后提前推进水位；重试、重启和并发 sync 以已提交水位继续，不重复追加旧 localId。`hasMore` 只反映本次页的 `nextCursor`，不循环到空；之后新到事件留给下一次显式 sync。原始消息账本是只读来源，不删除源游标、不修改 ACK/信封；无需修改 `host.sqlite`/`messages.sqlite` schema，也不改 primary 索引或 requestId 映射。未知/未来持久文档版本的拒绝继续向上传递，不能重置状态。

### 来源条目与真实作者

每条导入 Entry 的 kind 为 `host.scope-message`，data 精确包含 `{version:1, scopeKind, localId, digest, storedAt, selfEcho, message}`，保留完整不可变信封（含 `author.kind`、rootId、replyTo、category、revision、targets）。`missingRefs` 是读取时可变化的派生值，不固化进 Entry。

Entry.model 恰有一条 `role:'user'` 消息，内容为固定的外部事件/数据前缀加 `JSON.stringify(data)`，时间戳为 `Date.parse(storedAt)`。**这个 role 只是模型上下文载体，不是真实作者身份**：真实作者始终在 `data.message.author`，人类仍为 `kind:'user'`，Bot 仍为 `kind:'bot'`；不冒充 system/assistant，也不把外部文本提升为宿主/工具指令。导入本身不执行正文，但载体说明不会一概要求忽略真实人类请求。public/notice/request/reply 与 selfEcho 都可作为来源数据导入，本模块不决定哪些事件触发推理。ACK 与工具进度本来就不进入消息 inbox。原始 Entry 与源账本均保留，后续 BC 只压缩投影。

### Runtime 与公开类型

`WorkContextRecord` 仅含 `deviceId`、`botId`、`scopeId`、`kind:'room'|'dm'`、`conversationId`（公开 UUID）、`createdAt`（ISO 字符串）、`lastImportedLocalId`、`importedCount`；后两项初始均为 0，不暴露 SDK 数字会话 ID。

| 方法 | 结果与语义 |
| --- | --- |
| `getWorkContext(botId, scopeId)` | `WorkContextRecord \| null`；已授权但未绑定返回 null，不创建 conversation |
| `syncWorkContext(botId, scopeId, {limit?})` | `WorkSyncResult {context, imported, hasMore}`；显式调用可为空的已授权 scope 建立绑定，`imported` 是本次追加数 |
| `workHistory(botId, scopeId, {limit?, cursor?})` | `WorkHistoryPage {botId, scopeId, conversationId, items, nextCursor}`；返回该工作上下文原始 Entries，未绑定时 conversationId=null、空 items、null nextCursor，不创建 |
| `workContextStatus(botId, scopeId)` | `WorkContextStatus`：复用 `ContextStatus` 的 BC 字段，加 scopeId，conversationId 可为 null；未绑定返回空 BC 状态，不创建或准备投影 |

所有方法返回 Promise。sync 的 `WorkSyncOptions` **只**允许 limit，默认 50、最大 200、正安全整数；未知字段或无效值在创建绑定前报 `INVALID_ARGUMENT`。历史同样默认 50、最大 200，使用自己的游标，不接受源消息 inbox 游标。

`WorkHistoryCursor` 精确包装为 `{conversationId: <公开 UUID>, position: <非 null、非数组的 SDK 游标对象>}`，只允许这两个包装字段。调用方原样传回 `nextCursor`；拒绝其他工作上下文/主私聊 UUID、裸 SDK 游标或额外包装字段，未绑定上下文不接受非空游标，均为 `INVALID_ARGUMENT`。主私聊的既有历史游标格式不变。

四个方法复用原 Host/harness/BC manager，不新增 Runtime。工作引擎仅在需要消息操作时懒开自己的 MessageLog，纯主私聊路径不因此创建 `messages.sqlite`；关闭时拒绝新工作操作，等待已接纳操作结束后关闭自有 log，再由 Runtime 关闭 harness 等原资源。主私聊 submit/wait/history/getSubmission/abort/watch 与模型选择语义不变。

### 本机 HTTP、客户端与 CLI

本轮只扩展已有认证本机 Control API，沿用 Bearer、Origin 拒绝、请求体限额及关闭规则：

| 方法与路径 | 输入 | 成功响应 |
| --- | --- | --- |
| GET `/v1/bots/:botId/work-contexts/:scopeKey` | — | 200 `WorkContextRecord`；未绑定为 404 `WORK_CONTEXT_NOT_FOUND`，不同于 Runtime 的 null |
| POST `/v1/bots/:botId/work-contexts/:scopeKey/sync` | `{limit?}` | 200 `WorkSyncResult` |
| GET `/v1/bots/:botId/work-contexts/:scopeKey/history?limit=&cursor=` | cursor 为上述包装的 JSON | 200 `WorkHistoryPage` |
| GET `/v1/bots/:botId/work-contexts/:scopeKey/context` | — | 200 `WorkContextStatus` |

新增错误映射 `SCOPE_NOT_FOUND`/`WORK_CONTEXT_NOT_FOUND`→404、`SCOPE_FORBIDDEN`→403；参数/游标错误为 `INVALID_ARGUMENT`→400。共享 history helper 仅转换已识别的 SDK 原生游标错误，不因请求带 cursor 就吞掉存储故障；真实 SQL 读取错误仍保留 `ERR_SQLITE_ERROR`，HTTP 返回 500。未绑定但已授权的 history/context 查询仍成功返回空状态。

`createControlClient` 增加 `getWorkContext(botId, scopeId, options?)`、`syncWorkContext(botId, scopeId, input?, options?)`、`workHistory(botId, scopeId, options?)`、`workContextStatus(botId, scopeId, options?)`；sync 的 input 为 `WorkSyncOptions`，默认 `{}`。history 的 options 是 `{limit?, cursor?:WorkHistoryCursor|null, signal?}`，其他 options 为 `{signal?}`。signal 仅取消 HTTP 等待，不代表导入未提交、回滚收件或停止推理；不确定时可重查水位或重试 sync。

新 HTTP 路径的 botId 段沿用 `encodeURIComponent`，scope 段使用 **`scopeKey='~'+encodeURIComponent(scopeId)`**。服务端对该段解码一次，要求前导 `~`，仅剥去一个 `~` 后把原始 scopeId 交给 Runtime；缺少前缀或解码后 ID 为空报 `INVALID_ARGUMENT`。例如 `'.'→'~.'`、`'..'→'~..'`、`'~.'→'~~.'`，避免 WHATWG URL 折叠点路径且不碰撞、不收窄模块 7 合法 ID。JS/CLI 调用方始终传原始 scopeId，由客户端完成编码；仅这四个新 HTTP 路由使用 scopeKey，不改 Runtime/MessageLog 标识或既有路径，也不兼容未加前缀的新路径。

```bash
node host-core/control-cli.js work-get --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
node host-core/control-cli.js work-sync --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1 --limit 50
node host-core/control-cli.js work-history --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1 --limit 50
node host-core/control-cli.js work-context --url http://127.0.0.1:8787 \
  --token-env CONTROL_TOKEN --bot-id "$BOT_ID" --scope-id room-1
```

四个命令均要求 `--bot-id --scope-id`；work-sync 仅额外允许 `--limit`，work-history 允许 `--limit --cursor`（上一页包装游标的 JSON），其余拒绝无关选项。旧控制命令也拒绝不适用的 `--scope-id`，不静默忽略。复用原 HTTP 客户端与 JSON 输出，不增加打开第二个 Runtime 的 CLI。

### 模块 10 验收

父助手在 **Windows x64 / Git Bash、Node 26.8.2 与 22.19.0** 下完成 **149/149 个检查点，失败 0**。验收使用本机独立 Host 进程和真实 CA 校验的认证 WSS，模型服务为 **Mockoon OpenAI-compatible SSE**，未调用外部真实付费模型。

- **隔离与分页**：12 个并发 sync 处理 30 条交错收件，合计只导入 30 条，5 页 history 得到 30 个不同 messageId。Bot/room/DM/BC 隔离、真实作者、自身回声、先 reply 后 parent 与旧成员冻结目标通过；262144 字节的 65536 个 emoji 在原始 Entry 与模型载体中完整保留，并由 Node 22 实际读取。
- **原子回滚**：新绑定与已有上下文分别在双消息批次第 2 条注入 SQL 故障，整页 Entries/水位回滚，新绑定及其 BC 初始化也一起回滚；重启后完整补入，再 sync 为 0。未来 WorkDoc version 2 与 BC kernel 999 被拒绝且不重置；纯主私聊路径不打开 `messages.sqlite`。
- **可靠强杀证据仅取第 3 次**：Host 先健康，在 SQLite 写锁下 POST 请求体已发出、health 被阻塞，随后记录 Host exit 137 与客户端 reset 56；恢复后无半成品，显式 sync 导入 1 条、再次为 0。前两次未证明请求已接纳，不计作进行中恢复证据。
- **断连与收件独立**：已受理 sync 被写锁阻塞时 HTTP 客户端超时断开，释放锁后仍完成导入，重试为 0。Runtime 关闭期间，独立消息链路经认证 WSS 落盘并 ACK；重开时上下文水位仍旧，显式 sync 才导入。主私聊处于 placed 时也实际导入了新消息。
- **不自动调用模型**：最终 4 个模型请求全部来自 4 次显式主私聊提交，没有工作上下文推理；检查到 Host A 的 16 个工作上下文共 0 个 tasks。模型 wire 与 primary SSE 均无群/DM 标记；导入不准备 BC 压缩投影。
- **接口与错误边界**：本机 HTTP/CLI、`~` 前缀 scope 路径和绑定游标通过；原生游标错误映射为 `INVALID_ARGUMENT`/400，真实 SQL 读错仍为 `ERR_SQLITE_ERROR`/500。原远程 **10 个方法**全部回归；尝试远程 `workHistory` 被拒为 `not-sent`，新 work API 仍仅限本机。

公开声明检查通过，采用 `--strict --skipLibCheck`（记录为 `types-final.out`）；不加 skipLibCheck 时，既有 `@google/genai` 声明引用缺失的可选 `@modelcontextprotocol/sdk/client/index.js`，本轮未改依赖。6 份数据库完整性/外键检查通过；中心仍仅 `relay_devices`，数据库与 relay 日志未见选定正文标记。5 个核心服务 exit 0、Mockoon 以 143 结束，22 个辅助进程已清理，无本轮残留；没有使用或迁移生产数据。

详细报告保存在仓库外：`C:/Users/46040/AppData/Local/Temp/e-launcher-work-contexts-1792552863388/module10-verification.json`。模块 1–9 的验收记录和限制保留。

### 后续边界与未实测

- 模块 11 的自动收件调度、工作上下文推理/发言或沉默、Bot 通信工具尚未实现；模块 12 的成员同步/历史补齐、模块 13 的长期事实记忆也不在本轮。本模块不是新的 Session 产品或 UI。
- 模块 9 远程协议保持原 **10 个方法**，未增加远程工作上下文控制；版本化接线属于模块 14。
- 未实测：跨物理设备/WAN、Linux、Android、arm64、Tauri/TUI、浏览器 native-fetch 适配集成、真实外部付费模型。
- 未实测直接 JS AbortSignal 与直接 `Runtime.close` 并发调用/关闭竞态；已实跑服务端 HTTP 断连继续导入和进程优雅关闭。全局 128 pending/256 连接负载、中继慢接收者压力测试及模块 9 原有未实测项继续保留。
