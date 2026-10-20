# @e-launcher/host-core

模块 1：共享 Bot/Host 本机登记簿。提供本机 Bot 定义与主私聊记录的持久化，单 Host 所有者，跨进程身份稳定。包正式名为 `@e-launcher/host-core`；当前仓库尚无 workspace/包安装连接，示例直接从仓库根导入本地文件（见下文）。

整体方向见 [../docs/next-generation-architecture.md](../docs/next-generation-architecture.md)（状态：未来设计）。

## 实现与边界

- 需要 Node >= 22.19.0（package.json 中 `engines.node` 声明的最低版本）。存储用 Node 内置 SQLite（`node:sqlite`），数据库文件即 `dataRoot/host.sqlite`；新的 dataRoot 会自动建立（含必要的目录与库文件）。
- 只做 Bot/Host 定义与主私聊记录的持久化；不运行模型、Durable、BC，不加入 runtime 空插槽、群聊或 HTTP 服务。
- 写入由 SQLite 事务保护，重复请求重试安全。
- 本模块当前只是登记簿，**不是** Durable 内部状态库，也未接好 BC。
- SQLite 宿主适配尚未在 Android 验证；旧运行链路未被替换。
- dataRoot（数据库/记录）与 cwd（工具默认工作目录）分离：不 `process.chdir`，本模块也不往 cwd 写入任何文件。

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
- `index.js`：re-export openHost（仅此一个导出）。
- `index.d.ts`：BotRecord、CreateBotInput、Host、openHost 类型。

## 本次模块验收

父助手在 Windows / Git Bash 下以 Node 26.8.2 和最低版本 Node 22.19.0 执行了真实 CLI 跨进程验证：创建、列举、两种查询、重启后身份与记录稳定、重复请求、请求冲突和输入错误均通过。8 个进程并发首次建库及提交同一请求，最终只保留一个 Bot；不同请求并发也能完整保存。

通过 SQLite 触发器模拟 Bot 写入后、主私聊写入前的失败，确认 Bot、主私聊及请求记录一起回滚，修复后同请求可正常提交。更高版本、未知表结构和损坏数据库均被拒绝且原文件保持不变；外键、完整性检查及公开类型声明检查通过。

验收数据与报告保存在仓库外临时目录，没有新增测试文件。Android 和 Linux 尚未运行本模块；本次验收不包含 Durable/BC 或现有 Android 应用集成。
