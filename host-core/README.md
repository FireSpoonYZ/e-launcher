# @e-launcher/host-core

本机 Bot/Host 核心。模块 1 提供 Bot 定义与主私聊身份登记；模块 2 接入 Pi Durable 长期主私聊、历史与执行恢复；模块 3 内嵌 Billion Context；模块 4 接入本机工具（read/write/edit/bash 与 grep/find/ls）。运行时由单 Host 所有者持有，跨进程身份稳定。包正式名为 `@e-launcher/host-core`；当前仓库尚无 workspace/包安装连接，示例直接从仓库根导入本地文件（见下文）。

整体方向见 [../docs/next-generation-architecture.md](../docs/next-generation-architecture.md)（状态：未来设计）。

## 实现与边界

- 需要 Node >= 22.19.0（package.json 中 `engines.node` 声明的最低版本）。存储用 Node 内置 SQLite（`node:sqlite`），数据库文件即 `dataRoot/host.sqlite`；新的 dataRoot 会自动建立（含必要的目录与库文件）。
- `openHost` 负责登记；`openRuntime` 负责 Pi Durable 主私聊、内嵌 BC 及本机工具。群聊、隧道或 HTTP 服务仍未接入。
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
- `index.js`：导出 `openHost` 和 `openRuntime`。
- `index.d.ts`：登记接口，以及 `Runtime`、`PrimarySubmission`、`HistoryPage`、`OpenRuntimeOptions`（含可选 `bashPath`/`toolPaths`）等类型。
- `host-environment.js`：HostExecutionEnv（NodeExecutionEnv 子类）；仅命令字符串经 Git Bash/bash 执行，argv 数组与文件操作直接透传。
- `grep-tool.js` / `find-tool.js` / `ls-tool.js`：grep（rg）、find（fd）、ls 工具。
- `search-bin.js`：rg/fd 固定版本、asset 规格与解析顺序；`prepare-tools.js`：显式下载并安装 rg/fd 的 CLI。

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
