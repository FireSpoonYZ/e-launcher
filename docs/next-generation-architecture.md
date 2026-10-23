# 下一代多端 Bot 架构设计

> 状态：目标架构设计，整体尚未实现。[Bot/Host 核心](../host-core/README.md) 已独立实现模块 1 本机登记、模块 2 Durable 长期主私聊、模块 3 内嵌 Billion Context、模块 4 本机工具及模块 5 本机控制面（长期本地 Host 控制 API：基础 HTTP、回环端口、Bearer 令牌认证、拒绝全部 Origin；配套 Node/浏览器兼容客户端）及模块 6 主私聊实时预览（认证本地 SSE：有界快照+整体替换更新、每订阅 sequence 非持久游标，原始历史分页保留；无群消息/中心/Tauri，无轮询或新调度器）；模块 7 已实现本机持久消息账本（作用域/成员修订、不可变信封、outbox、落地去重 ACK、本地收件/历史/缺口、特权离线 CLI；仅 messages.sqlite 本机存储，无网络认证/隧道/中心/推理）；模块 8 已实现认证设备中继与 Host 消息投递（中心只存设备注册，复用模块 7 outbox，本机进程网络端到端已通；跨设备/真机网络验收与完整中心产品尚未完成）；模块 9 已实现认证远程 Host JSON 控制（固定 10 个 JSON 方法、独立多客户端角色、Node 客户端与一次性 CLI；父助手已完成本机独立进程 171/171 个端到端检查点验收，具体范围见下文）；模块 10 已完成群与 Bot DM 的独立被动工作上下文（显式导入、独立 Durable/BC、本机 API/CLI；父助手完成 149/149 个检查点，范围与限制见下文）。模块 11 已完成自然群聊决策与通信工具（父助手完成 161/161 个端到端检查点及 18 份数据库完整性/外键检查；本机 WSS 与脚本化模型服务，范围与限制见下文）。模块 12（成员范围管理与历史补齐）已完成父助手限定范围验收（122/122 检查点，见下节）。模块 13（Hindsight → Pi Durable 长期事实记忆）已完成 Host 侧适配交付（进度 13/20；真实 Hindsight 服务联调未做）。模块 14（统一 Host 服务与设备接入）已完成父助手限定范围验收（139/139 检查点，见下节）。模块 15（Android 本机 Host）已交付并获父助手验收（见 §7），总完成数 **15/20**。模块 16（旧数据迁移与 Android 兼容）已交付并获父助手限定范围验收（见 §7），总完成数 **16/20**。总计划 20 个模块、已完成 16 个、17–20 共 4 个待交付。整体通信（框架隧道/中心产品）、跨端与外壳（Tauri/TUI）尚未完成。本文约定产品方向、首版设计默认与工程验证边界，不授权删除现有能力。当前安装、构建及运行行为仍以 [README](../README.md) 为准。

当前交付计划与完成/剩余模块见 [重构路线图](refactor-roadmap.md)。

## 1. 已确认目标与首版边界

1. **采用 B：Bot 在指定物理设备、指定默认目录长期工作。** Windows、Linux、Android 都能承载 Bot；Pi Durable 代理循环、模型请求发起、原始历史、压缩状态及长期记忆均在该设备。模型服务可以是外部 API，这不等于本地模型推理。
2. **统一核心，不削弱 Android。** 各端共享 Host/Bot 核心、设备控制面和业务协议，Android 保留工具与原生桥。目标界面是 Tauri Android/Windows/Linux，加 Windows/Linux TUI；允许先迁核心再迁外壳，不永久取消 Tauri Android。
3. **任意客户端访问任意已授权设备。** 创建与访问本机、跨机 Bot 使用相同语义。只有目标 Host 确认才算创建完成；离线只可待发送，不能由中心虚报 ready。
4. **中心只做设备注册、框架内部隧道和跨设备 Bot 通信。** Bot 列表、状态、历史现场查询 Host；中心不持久保存全局 Bot 目录、聊天历史、上下文或模型凭证，不运行 loop、路由 LLM，不指定群记录主机，不提供通用 VPN/端口转发。
5. **单一人类用户，多设备、多 Bot。** 需要安全设备认证及本机执行授权，不做多人参与或多租户权限平台。
6. **Pi Durable 已定。** 不再比较 SDK，不做旧 coding-agent ExtensionAPI 通用兼容层。Windows/Linux 提供 read/write/edit/bash/grep/find/ls；Windows 命令环境是 Git Bash，Linux 是 bash，不增加 PowerShell 工具。
7. **内置 Billion Context（BC）。** 每 Host 内嵌上游 acp-kernel 和必要上下文工具，无须另装 bili 或代理，不自研压缩算法。默认保留原文，按 conversation 稳定绑定引用、压缩状态和出处，只有一个压缩所有者；自动记忆可查来源、纠正，不逐条审批。
8. **每 Bot 有长期主私聊。** 群聊、Bot 间私聊各有工作上下文，不让用户管理 Session，也不共享全部原文。暂不新增后台任务工作台、自动 routine、定时或任务编排产品；Durable Task 是内部机制。运行中的 Agent 不因切界面而退出。现有 schedule_task/AlarmManager 能力及数据保留，另列新版兼容项。
9. **Android 远程响应优先。** 按持续接单的本机宿主设计，不加入应用自定空闲省电、主动休眠或“省电/常驻”二选一模式；系统电池和后台设置由用户控制。系统回收、force-stop、断网仍可能离线，必须补投恢复；Widget 冷读不启动运行时。
10. **群聊保留全员接收、自主发言或沉默。** 不中央选唯一发言人，不强制 @ 才答；消息保存不等于立即推理。以下批量决策、发布复核及续聊边界是基于调研的首版设计默认，不宣称所有细节已经用户逐项批准。
11. **Bot 间 DM 是持久私聊，不是任务工单。** 有对话范围、作者、replyTo，支持通知、请求、相关回复和沉默；回复不自动成为新请求，内部 ACK 不进聊天，只有主动公开发送才进群。
12. **记录属于成员 Host。** 各 Host 保存自己收发的群事件、DM 和私有执行状态，其他端经 API 读取。无中心聊天库或独立群日志主机；固定发送 ID、持久 outbox、接收落盘去重 ACK、补史和缺口标记构成可靠投递边界，不复制整套 Matrix 共识。

## 2. 架构与职责

```text
 Tauri Android / Windows / Linux       Windows / Linux TUI
                  \                       /
                   +-- 同一业务 API ------+
                        | 本机直连 / 框架隧道
             +----------v-----------------------+
             | 轻中心：注册、认证通道、通信中继  |
             | 无 Bot 目录、聊天库、模型 loop    |
             +-------+------------------+-------+
                     |                  |
          +----------v-------+  +-------v----------------+
          | Windows/Linux Host| | Android Host           |
          | 控制面、Bot 核心  | | 同一核心与控制面        |
          | Durable + BC      | | Durable + BC + 原生桥   |
          | 本机库、工具、cwd | | 私有库、现有工具/Shower |
          +---------+---------+ +-----------+------------+
                    |                       |
                    +---- 各自请求模型 API --+
```

本机路径不必绕中心，但不能另做一套“本机 Bot”产品。Host 主动建立认证通道，无须把设备任意端口暴露给外网。中心转发受业务协议约束的设备控制与消息，不开放通用网络隧道。

| 位置 | 持有与负责 | 明确不负责 |
| --- | --- | --- |
| 中心 | 已注册设备身份、连接路由；认证隧道、背压与离线反馈；Bot 消息中继 | 权威 Bot 状态、持久信箱、聊天检索、模型凭证、模型选人或执行 |
| Host | 本机 Bot 定义与控制面；Durable、BC、模型请求；本机存储、投递、历史及工具授权 | 替离线设备推进其 Bot、擅自迁移执行位置 |
| 客户端 | 查询与展示、创建/发送/停止；离线待发草稿与标明时间的缓存 | 凭缓存宣称实时完整、冒充目标 Host 确认创建 |

一个 Host 可用一份本机 SQLite 管多个 Bot 和 conversation，不要求每 Bot 独库。数据库及 Durable 状态写入应有明确所有者，界面不直接改运行状态；具体存储适配需原型确认，不预设 Durable 与 kernel 已有可直接共用的数据库适配。

### 概念及位置

- **Device**：已注册物理设备，稳定 deviceId、认证信息与平台能力；在线是连接观测，不是永久可用承诺。
- **Host**：设备上的实际宿主，管理运行时、存储、控制面和工具。界面关闭与 Host 生命周期分离。
- **Bot**：稳定 botId、角色、所属 deviceId、默认 cwd、模型配置、允许共享的知识及主私聊。目录必须在目标设备确认，工具始终在该机执行，不自动换机。
- **Room**：公开群范围与成员 Bot；主私聊、双方 Bot DM 是独立私有对话范围。成员可分布于多个 Host，同机成员也按同一消息语义处理。
- **Message**：带作者、范围和因果关系的持久事件，不等于模型的一次请求或一次运行。
- **conversation**：内部上下文与恢复标识。主私聊、每个 Bot 的每个群/DM 分别绑定；同一 DM 的双方 Bot 各有独立工作上下文，用户无需创建或切换 Session。

cwd 是工具默认工作目录，不是数据库目录或进程全局 cwd。Host 记录每个 Bot 的显式 cwd，并在调用时传递，避免多 Bot 互相污染。原文、附件引用、投递、压缩及记忆放在 Host 管理的私有数据内；工作文件留在实际工作目录。桌面端确定数据根目录后记录在配置中，Android 新存储留在现有私有应用目录。界面持续显示 Bot 所在设备和 cwd，不靠模型猜测。

## 3. 创建、访问与离线

客户端先查询已注册设备，再经本机连接或隧道查询各 Host 的 Bot 列表。聚合列表只是一组现场查询结果：离线设备显示“不可查询”，客户端可展示带来源、更新时间的旧缓存，不能把未返回解释为没有 Bot。状态与历史也遵守这一规则。

创建请求携带稳定请求 ID、目标设备、角色和 cwd。目标 Host 校验身份、本机权限、目录与工具环境，持久化 Bot、主私聊及请求结果后返回 botId。重复提交返回同一结果；如果回执丢失，重连先按请求 ID 查询，不能盲建第二个。目标离线时请求只在发起端本地待发送，用户可取消，中心不预先建立 ready Bot。

访问同一 Bot 不因换客户端建立新身份或搬走原文。客户端发送后区分“本地待发、Host 已保存、运行中、已结束”，传输成功不等于执行完成。中心离线时本机直连仍可工作；跨机不可达则等待，不自动改用其他设备执行。恢复连接后先校对收件和运行状态，再续传固定 ID 的未确认项。

## 4. 工具、Durable 与 Billion Context

### 统一协议，按平台提供能力

工具描述、参数、调用 ID、结果、错误、取消及授权状态使用共同协议；平台能力由 Host 报告，不强制工具集合完全一致。read/write/edit/bash 四项使用 Durable 原生工具；grep/find/ls 复用现有 Pi 能力或做等价小适配，不为了旧扩展机制重新封装整套 SDK。

Windows Host 明确定位 Git Bash 并验证环境，不能任由 PATH 误选 shell；Linux 使用 bash。缺少所需 shell 时报告不可用，不静默改用 PowerShell。这只约束新版 Bot 命令执行，不改变现有 PowerShell 构建脚本，也不改写现有远程终端支持 PowerShell/Bash/Nushell 的事实。

Android 迁移现有工具能力及 Java 桥，包括文件、语音、分享、应用与 Shower 等实际能力，不降级为远程壳或纯工具端。原生模块继续处理系统权限、Binder、附件与界面入口；工具输出、网页和屏幕内容均不可信，不能据其文本扩权。

### 模块 4：本机工具已实现

模块 4 已接入本机工具：read/write/edit/bash 复用 pi-durable 原生工具，grep/find/ls 为本模块适配（rg/fd/文件 API）。工具在 Bot Host 上执行，cwd 默认位置不是沙盒；不 `process.chdir`，按 conversation+cwd 缓存执行环境，运行时关闭时清理环境进程。

Windows 命令环境只在固定 Git 安装目录定位 Git Bash，Linux 固定 `/bin/bash`、`/usr/bin/bash`，均不搜索 PATH，不提供 PowerShell；缺少 shell 只影响 bash 工具，文件工具仍可用。`openRuntime`/配置支持可选 `bashPath`（绝对路径 bash/bash.exe）与 `toolPaths`（`{rg, fd}` 绝对路径），仅 undefined 视为未提供，存在性在使用时懒检查。

rg/fd 定位顺序：显式 toolPaths -> dataRoot 固定版本（`<dataRoot>/tools/<platform>-<arch>/<name>-<version>/`）-> Pi agent bin -> PATH（Linux fd 别名 fdfind）。模型调用不触发下载；`node host-core/prepare-tools.js --data-root ...` 显式安装 rg 15.1.0 / fd 10.3.0（curl/tar，Windows 仅 System32 tar、无 PowerShell 回退；固定官方 URL、固定 entry 流式提取、LICENSE-MIT 随下载保存、原子发布、sha256 指纹）。资源安装目前仅在 Windows x64 实际运行，四平台验收未完成。

工具限额：find 默认 1000 条（上限 10000）、50KB、60 秒，坏 glob 报错，NUL 分帧防换行文件名；grep 单 JSON 记录 64KiB、每行 500 Unicode 码点、50KB、60 秒，自设限只取消自身进程；ls 纯文件 API、无外部程序。重放沿用原生安全语义，不承诺外部 shell 副作用 exactly-once；BC 复杂工具内容继续受保护，未做进一步结果卸载。

### 本机状态与恢复边界

Durable 保存代理执行与恢复所需状态；内部 Task 不暴露成独立任务产品。同一 conversation 的执行、输入处理水位和发送结果要能恢复；不同私聊/群上下文不因一个长运行全部阻塞，真实共享资源仍由本机协调。

工具调用和发送动作使用持久稳定操作 ID，区分未受理、已开始、结果已知与结果不明。重启后先查回执：确定未执行才重试；可能已写文件、操作 App 或产生外部效果而结果未知时，核查或报告不确定，不能因 Durable 可恢复就宣称 exactly-once。取消是请求，Host 确认停止才展示已停止；停止不撤销已经执行的工具或已发布消息。

### BC 的三层数据

| 数据 | 用途与规则 |
| --- | --- |
| 原始记录 | 默认保留原文、工具结果及附件引用，是可追溯依据，不被压缩投影覆盖 |
| 压缩投影 | 模型生成的摘要，以及 acp-kernel 管理的 refs、来源映射和压缩状态；按 conversation 稳定绑定，重试/恢复不随意重编号 |
| 长期记忆 | 自动提取的稳定偏好与事实，记录来源、适用范围和纠正；不是全部原文的另一个名称 |

每 Host 内嵌上游 acp-kernel 与必要检索/展开工具，不要求用户安装 bili、协议代理或额外常驻进程。一个 conversation 只设一个压缩所有者，避免 Durable 侧另一套压缩同时改写同一上下文。模型真实窗口仍有限，BC 管理累计历史与投影，不承诺十亿 token 实际窗口、固定节省率或必然准确找回。

**跨平台迁移仍需验证的接缝**是请求投影生成、kernel 状态提交、工具结果入库、重试与恢复的顺序。模块 11 已在下述限定环境实跑原生重试、请求前取消和故障恢复，不代表全部并发交错均已覆盖。beforeRequest 不是任意写状态接口，普通抛错也不等于阻止 provider；研究中的 PrepareRequest task 不能当作现有能力，不在设计中虚构 API。

Pi Durable 当前为实验性 API；实现时固定 Durable、pi-ai、chord 与 acp-kernel 的依赖版本，状态格式升级应有显式迁移，不能静默重置压缩引用或丢弃旧状态。

记忆自动提取后可查看出处、纠正错误，不逐条要求批准。角色、cwd、能力和允许共享的稳定知识保持连续；私聊事实默认保留原范围，不能把“可供自己推理”混同“可以公开原文”。纠正应更新派生记忆并保留追溯关系，不改写历史。模块 13 将经显式配置的 Hindsight 服务实现该长期记忆（见第 6 节模块 13）：提取只在该服务端，本机只保留适配侧跟踪/出处/纠正审计。

## 5. 长期对话与自然群聊

### 上下文分隔

人类与每 Bot 的主私聊长期存在；群聊各有该 Bot 的工作上下文；双方 Bot DM 另有工作上下文。切客户端或 UI 不新建 Session。群参与只带公开群事件、角色与获准共享的知识，不将主私聊或其他群全文灌入；私有执行轨迹不是群历史。

Bot DM 使用通知、请求、相关回复的语义，可查历史并允许沉默。请求可产生关联回复，但每条回复不会自动成为新请求，也不自动回“收到”。迟到回复按 replyTo 归回原问题，等待超时不意味着对方停止或需换 ID 重问。DM 仅双方可见；若要把结论带回群，Bot 必须另做公开发送，不能自动转发全文。

### 模块 10：独立工作上下文（已完成父助手验收）

模块 10 的已验收范围只包含**被动导入**，不包含下述已另行验收的模块 11 模型决策流程。已收件是消息账本落盘并可确认 ACK；已导入是事件进入该 Bot/scope 的 Durable 历史；已推理才是模型实际处理，三者不能混同。导入水位与 `importedCount` 不是模型处理回执。

- **稳定隔离**：按本机 `(botId, scopeId)` 绑定公开 conversation UUID，不把 revision 放进绑定键；新建 ownerless conversation 和独立空 BC 文档，不 fork/复制主私聊或其他范围。群成员修订沿用上下文，DM 固定双方；同消息面向多个 Bot 时各有自己的 UUID、BC 和水位。
- **先过滤、后分页**：`MessageLog.inbox(botId, {scopeId?, limit?, cursor?})` 的 scoped 查询沿用 SQL `(scope_id, local_id)` 范围索引，并在分页前以冻结 Bot 目标的 `EXISTS` 过滤，未新增 schema/索引迁移；跨所有修订，不用当前成员名单改写旧目标可见性。省略 scope 保持旧 inbox；scoped 游标绑定 Bot+scope，与旧全量游标不可混用。`selfEcho` 和动态 `missingRefs` 保留在查询结果中。
- **权限与退群**：要求本机 Bot、已知 scope，且是当前成员、已有该绑定或有历史目标收件。退群后可保留上下文并导入迟到的旧目标消息，不能获取未面向自己的新事件；无权限时拒绝，不以 scope-wide history 或其他 Bot 收件补足。
- **原子水位**：每次显式 sync 只处理一页（默认 50、最大 200）。同一 Durable commit 内重查/创建绑定、读取当前水位和 scoped 源页、追加 Entries、更新水位/计数，失败一起回滚；重复、并发和重启按已提交本机 localId 继续，迟到旧修订事件不因源序号较小而被跳过。源账本只读，不改 ACK/信封。
- **真实作者与模型载体分离**：`host.scope-message` 的 data 保留 `{version:1, scopeKind, localId, digest, storedAt, selfEcho, message}`，message 是完整不可变信封，`author.kind`、rootId、replyTo、category、revision、targets 不重写；动态 missingRefs 不固化。Entry.model 的单条 `role:'user'` 只是固定外部事件前缀+JSON 的载体，不把 Bot 作者变成人类；真实作者仍在 `data.message.author`（人类 user、Bot bot），不伪装 system/assistant 或赋予正文宿主/工具指令权限；导入不执行正文，也不一概要求忽略真实人类请求。各类别与 selfEcho 都可被导入为数据，ACK/工具进度不进 inbox，推理资格留给模块 11。
- **只初始化，不生成**：继承 Bot 角色/cwd 和 Host 工具/执行环境配置，但不选择模型；复用同一 Runtime/harness/BC manager。导入使用公共 `Tx.appendEntry`，方法本身不 submit/wait/resume/startRun、不创建模型任务或轮询。模块 11 激活后独立驱动可处理同一批合格收件，不把驱动生成误称为 sync 直接调用模型。独立空 BC 状态不代表已压缩：导入不调用 prepare，不产生摘要投影；原始 Entry 与消息账本保留，推理时 BC 只压缩投影。

本机 Runtime 提供 `getWorkContext`、`syncWorkContext`、`workHistory`、`workContextStatus` 四个操作。三个只读操作不创建绑定；未绑定时分别返回 null、空历史页（conversationId=null）或空 BC 状态；显式 sync 可以给空的已授权 scope 创建绑定。`WorkContextRecord` 仅含 deviceId、botId、scopeId、kind、公开 conversationId、createdAt、lastImportedLocalId、importedCount 八项，不暴露 SDK 数字 ID。工作历史游标精确为 `{conversationId:公开UUID, position:非null的SDK游标对象}`，拒绝其他范围/主私聊/裸游标或额外包装字段，未绑定时不接受非空游标；旧主私聊格式不变。共享 history helper 仅把已识别的 SDK 原生游标错误转为 `INVALID_ARGUMENT`/400，真实 SQL 读错仍保留 `ERR_SQLITE_ERROR`/500，不因携带 cursor 就改报参数错误。

本机 HTTP 对应 GET `/v1/bots/:botId/work-contexts/:scopeKey`、POST `…/sync`、GET `…/history` 与 GET `…/context`；get 未绑定时为 404 `WORK_CONTEXT_NOT_FOUND`。新路径的 `scopeKey='~'+encodeURIComponent(scopeId)`，服务端解码一次后要求并仅剥一个 `~`；`.`/`..`/`~.` 分别为 `~.`/`~..`/`~~.`，避免 URL 点路径折叠。缺前缀拒绝 `INVALID_ARGUMENT`，JS/CLI 仍传原 scopeId，旧路径不变。配套客户端及 `control-cli.js` 的 `work-get`/`work-sync`/`work-history`/`work-context` 共用原本机认证服务，均需 botId/scopeId，不另开 Runtime；signal 仅取消 HTTP 等待，不保证撤销已提交导入。完整参数与错误见 [Host 核心模块 10 说明](../host-core/README.md)。

父助手已完成 **149/149 个检查点，失败 0**。环境为 **Windows x64 / Git Bash、Node 26.8.2 / 22.19.0**，本机独立 Host 进程经真实 CA 校验的认证 WSS 收件；模型为 **Mockoon OpenAI-compatible SSE**，非真实外部付费模型。公开声明在 `--strict --skipLibCheck` 下检查通过，未改依赖；既有上游声明引用的可选模块缺失，具体限制见 Host 核心说明。

实跑覆盖并发分页去重、Bot/room/DM/BC 与作者隔离、旧目标和迟到引用、Unicode 原文，以及整页/水位/新绑定与 BC 的 SQL 故障原子回滚。进行中强杀证据仅采用第 3 次（健康 Host、请求体已发出、写锁阻塞 health、exit 137/client reset 56）；恢复后 sync 导入 1 条、再试为 0，前两次未证实请求接纳，不计该证据。已受理 sync 的 HTTP 超时断连不阻止释放锁后完成导入；Runtime 关闭期间消息链路仍可落盘 ACK，重开后显式 sync 才推进水位。

最终 **4 个模型请求均为 4 次显式 primary 提交**，没有工作上下文推理；Host A 的 16 个工作上下文共 0 个 tasks，模型 wire 与 primary SSE 无群/DM 标记。原远程 10 方法回归通过，远程 `workHistory` 拒绝为 `not-sent`；本轮四个 work 操作仅限本机（M14 v2 起远端已支持固定 work RPC，见下节）。数据库检查与本轮进程清理完成。详细报告在仓库外：`C:/Users/46040/AppData/Local/Temp/e-launcher-work-contexts-1792552863388/module10-verification.json`。

未实测跨物理设备/WAN、Linux/Android/arm64、Tauri/TUI、浏览器 native-fetch 适配集成及真实外部付费模型；直接 JS AbortSignal、直接 `Runtime.close` 并发调用/关闭竞态也未实跑；本轮已测 HTTP 断连和进程优雅关闭。全局 128 pending/256 连接负载、中继慢接收者压力及模块 9 既有限制保留。

以上是模块 10 的历史验收记录，不作为模块 11 自然群聊决策/发言/通信工具的验收证据；模块 11 的独立验收见下节。模块 12 成员同步/历史补齐已完成父助手限定范围验收；模块 13 长期事实记忆已完成 Host 侧适配交付。模块 9 中继远程协议保持固定 10 个方法，远程 work 版本化接线属于模块 14（M14 v2 起已扩展为 35 个固定方法并支持固定 work/memory RPC，见下节）；不增加 Session 产品或 UI。

### 模块 11：自然群聊决策与通信工具（已完成父助手验收）

模块 11 已完成父助手在下述限定环境中的 **161/161** 个检查点，总完成数为 **11/20**；这不是跨平台或真实智能模型群聊质量的验收。执行继续由各 Bot 的所属 Host 承担，每个本机 `(botId, scopeId)` 独立决策，没有中心模型、强制 @、唯一发言人或思考/回复次数上限。

```text
消息去重落盘 -> ACK（只确认落盘）-> 自身冻结目标 inbox
                                          |
                 显式 Runtime.resume 激活本机自动处理
                                          v
           分页导入、忙时合并（每 Bot/scope 至多一个 pending）
                                          |
       自身回声、DM notice/reply ----------+--> 仅作上下文
       ACK/工具进度不进入消息账本           |
       他人 room public 或 DM request ----+--> 追平后开始决策
                                          v
                   实际冻结来源视图 + 独立 BC 投影
                                          v
          多轮工具查证 -> 显式通信工具发布 / 不发布而正常结束
                                          |
                 发布前原子复核来源新收件 -> 旧稿失效后 replan
```

**主动与被动分开。** `openRuntime`、M10 get/sync/history/context 和 `getWorkActivity` 不激活工作决策；sync 仍只导入一页。只有 `Runtime.resume()` 激活独立驱动（同时恢复原生任务），立即及每约 1000ms 不重叠扫描，不等待模型自然完成；原主私聊 submit/wait 的原生执行语义保留。常驻 `openControlServer` 在监听成功后调用 resume，所以只读客户端接入的 Host 也可能正在自主推理并产生费用。

只使用已经安装的 room/DM scopes，不发现远端 Bot、不协商成员、不新建 DM 或补远端历史。消息库不存在时扫描不创建它；有库后按当前本机成员和已有绑定处理，不为空范围无端创建绑定。每次导入一页最多 200 条，追平后才起新决策，运行中/停止时仍可导入；原生 pending 先持久化再受理，重启按同 requestId 对账。退群后不开始推理，终止/对账旧 pending，但保留旧冻结收件、历史和未处理水位；退群不是 owner 停止，重新入群后若无停止/错误可继续。

**三个水位不能混同。** `lastImportedLocalId` 是已导入；`handledLocalId` 是策略已消费（也包括忽略的回声/notice/reply）；`pending.preparedThroughLocalId` 才是实际冻结模型请求中贡献来源内容的水位，不是最新导入、tokenCount 或 native EntryId。正常结束最多处理到自己的 prepared 水位，不跳过模型没看到的新输入。Host 触发信号明确为内部处理信号，不冒充人类；外部事件的 `message.author` 才是真实作者。

**原子发布复核。** 工具在原生串行提交点核对当前 stop/决策状态，再以 `MessageLog.publish(input,{scopeId,afterLocalId})` 同事务检查来源最新成员资格、新收件并写入 ledger/outbox。guard 的 scopeId 是决策来源，可与目标 DM/room 不同；任何更晚且冻结面向自己的非自身来源事件（包括 notice/reply、其他本机 Bot）使新发布报 `STALE_INPUT`，自身回声/其他 scope/其他 Bot 独有收件不算。失败不写消息/序号/outbox，驱动持久 replan，旧生成不再继续请求 provider，不推进处理水位；下一次重新考虑新批次。只保证本 Host 已收到的内容，不承诺各 Host 看见相同前缀。

省略 guard 保留旧发布语义，显式 null/未知字段/坏水位拒绝；guard 只允许 Bot 作者且不进指纹/信封。同 messageId/同指纹重放先返回已存回执，再谈数据库成员/新输入限制；冲突仍拒绝。消息去重不等于外部文件/命令副作用 exactly-once。

**只有工具发布。** 通信工具为 `list_scopes`、`read_scope`、`send_room`、`send_dm`、`read_dm_replies`、`wait_dm_reply`，不是 Durable 自带能力。每次从实际 conversation 解析本机 Bot，Host 注入作者；模型不能自报 author/Bot/messageId/guard。读取只取自己的冻结 inbox；列表只列当前成员 scopes。发送工具返回 stored 回执，不代表远端收到。messageId 存在 Durable task memo，重放不换 ID。最终 assistant 文本、工具日志和沉默理由保持私有，不自动广播；正常结束未发送就是沉默，没有 silent 工具或 `SILENT` 子串解析。同一决策允许多轮工具、多次发送。

**DM 请求与回复。** `send_dm` 明确 notice/request/reply；关联回复使用 reply + 原 request 的 replyTo，不自动成为新 request，也不必回 ACK。底层 `MessageLog.replies(botId,requestMessageId,{limit?,cursor?})` 只允许自己在本机发出的 DM request，取对方直接 replyTo，不能按 rootId 查整个链或读其他 Bot 的请求；乱序恢复不要求回复晚于请求入库。游标为 inbox kind、key=`'reply:'+sha256(JSON.stringify([botId,requestMessageId]))`，绑定设备/Bot/request，不与普通 inbox 混用。

`wait_dm_reply` 每次工具调用最多等 30 秒，等的是**首个对方回复**而非工作完成；返回 `status:'replied'|'timeout'`。截止时间存在 task memo，重放不延长；先查已有回复再判断截止，Host 停机期间到达的回复仍可读。超时不取消对方，不自动新发请求；之后继续用原 requestMessageId 查/等，新调用可有新期限，但不会把已读首回复当作“下一条”消费。群结论必须另外显式公开发送，不自动转发 DM 全文。

**预览与原文。** 通信工具 JSON 输出最多 50KiB UTF-8；消息正文预览最多 4096 Unicode 安全的 UTF-16 单元并带 `textTruncated`。页在整条 item 边界缩短，游标只越过最后实际返回的条目；list_scopes 同样保留 nextOffset（目录变化下仅尽力分页），单 scope 转义超限时的前缀分页与 `RESPONSE_TOO_LARGE` 边界见 [Host 核心说明](../host-core/README.md#有界工具预览不等于原文截断)。消息账本与工作原始历史完整保留，不据预览截断原文。BC 准备后的估计 tokenCount 达到 contextWindow 时以 `CONTEXT_LIMIT` 阻止模型请求，不丢弃大事件或推进 handled；更小估计也不保证 provider 的 system/tool 开销能放下，不自动另启 compaction。

**请求前原生取消修正。** pi-durable 1.3.0 的 HookRunner 会吞掉普通 beforeRequest 抛错。组合 hook 在工作策略 → BC prepare → 预算检查任一步出错、且本次 context 尚未取消时，先用**同一 invocation context** 调用 `harness.abortTask(api.taskId, context)`，再抛出错误；不取消整个 conversation/队列。正常关闭已取消该 context 时不追加持久 abort，不把暂停变成永久中止。旧稿 replan、零 provider 预算拒绝、工作 schema fatal、主私聊 BC prepare 失败无原文回退，以及等待工具关闭/恢复均已由父助手实跑。

**逐 scope 停止。** `stopWork(botId,scopeId)` 先持久 stopped，再 abort 并等待仅该工作 conversation 静止，不撤销消息/outbox、其他工具效果或历史，不影响其他 scope/主私聊。`Runtime.abort(botId)` 仍只指主私聊。重启、全局 resume、新的人类发言和重入都不能清 owner 停止；必须显式 `resumeWork`（要求当前成员，先清旧执行再清 stopped/error）。该方法只在驱动已激活时促其继续，不激活被动 Runtime。Host 退出是暂停，不冒充 stop。

`getWorkActivity` 被动返回 `WorkActivity`：公开 conversationId（未绑定 null）、isMember、stopped、导入/处理水位、pending、lastDecision 和小型 error；不暴露内部 nativeId/taskId/cutoff。status 优先级为 unbound → stopped → error → inactive → thinking → idle。pending 含 requestId、可空 submissionId、startedAt、可空 preparedThroughLocalId；lastDecision 含 requestId、silent/published/replan/aborted/failed outcome、可空 throughLocalId、completedAt。它是模型决策状态，不是投递 ACK 或“失败前无副作用”证明。

模型缺失/不可用和生成失败只阻塞本 scope（`MODEL_REQUIRED`/`MODEL_NOT_FOUND`/`WORK_GENERATION_FAILED`，保留已有 `CONTEXT_LIMIT`），修复后显式 resumeWork，不热重试。意外存储/schema 错误保留 fatal、停止驱动并对 activity/变更暴露，不吞掉或重置；需正确关闭/重开及处理原因。自动处理、被动工作接口和通信工具共用一份懒开 MessageLog，关闭先停驱动并静止已接纳操作，等 harness 关闭后才关 log；DeviceLink 的连接与锁独立。

**仅本机控制扩展。** Runtime/ControlClient 增加 `getWorkActivity`、`stopWork`、`resumeWork`；本机 HTTP 为 GET `/v1/bots/:botId/work-contexts/:scopeKey/activity`、POST `…/stop`、POST `…/resume`（两个 POST 要求解析后为空对象；零字节 body 沿用 `readControlBody` 约定视作 `{}`，客户端仍发送 JSON `{}`），均返回 WorkActivity。沿用 Bearer/Origin 规则及 scopeKey=`'~'+encodeURIComponent(scopeId)`，解码一次且只剥一个 `~`。客户端 options 仅 signal，取消 HTTP 不撤销已受理操作。CLI 为 `work-activity`/`work-stop`/`work-resume --bot-id --scope-id`（另加原 url/token-env 连接选项），拒绝无关参数。M10 四个本机 work 操作保留；远端仍是 getHostInfo/listBots/createBot/getBot/findByRequest/submit/getSubmission/history/abort/contextStatus 十方法，不增加远端 work 或群/DM live（截至 M11；M14 v2 起已支持固定 work/memory RPC 与远端 live，见下节）。

完整参数、DTO、使用示例及 `module11-verification.json` 证据位置见 [Host 核心模块 11 说明](../host-core/README.md#模块-11自然群聊决策与-bot-通信工具已完成父助手验收)。模块 **12** 已完成父助手限定范围验收（122/122 检查点，见下节 [模块 12](../host-core/README.md#模块-12成员范围管理与历史补齐已完成父助手验收)）；模块 **13** 已完成 Host 侧适配交付。模块 **14**（远程 work/实时接线、统一服务与本机设置、客户端待发送/对账）已完成父助手限定范围验收（139/139 检查点，见下节），总完成数 **14/20**；模块 **15**（Android 本机 Host）已完成父助手验收（见 §7），总完成数 **15/20**；模块 **16**（旧数据迁移与 Android 兼容）已完成父助手限定范围验收（见 §7），总完成数 **16/20**；模块 **17–20 共 4 个**仍待交付：跨平台/外壳与真机集成；不新增后台任务产品。

**模块 11 验收范围。** 父助手在 **Windows / Git Bash、Node 26.8.2 / 22.19.0**，使用 pi-durable **1.3.0**、acp-kernel **0.0.101**，完成 **161/161 个检查点，失败 0**。实际 localhost WSS 连接 Host A/B，模型 HTTP/SSE 进程使用脚本化 Mockoon 响应；这是实际运行协议与恢复机制的验收，不是付费模型或智能决策质量验证。

实跑覆盖无 @ 的独立决策、回声/notice/reply 不生新请求、真实作者及伪造字段拒绝、私有最终文本、旧请求停止且新决策实际发布、跨来源/目标 guard、退出/重入、持久 owner 停止、DM 直接关联/首回复/超时及跨 Bot 隔离。8 条预览分页恰好各一次，50KiB/Unicode 边界与完整原文通过，超大单 scope 在可用前缀之后明确报错。B Runtime 关闭时独立链路仍落盘 notice 并 ACK，重开仅导入；M10 被动方法、主私聊 history/live、空 Host 懒开、所有权、缺模型/配置后显式恢复及远端十方法回归通过，远端 work 扩展仍拒绝（截至 M11；M14 v2 起已支持固定 work RPC，见下节）。

等待 task **489** 优雅关闭后在 Node 22 按原 task/绝对截止恢复，不因停机过期重置 30 秒。发布 task **729** 在真实发送落盘、原生工具结果插入被 SQLite 触发器阻断后遭 SIGKILL，重开返回同一回执且只保留一条发布，更新输入未丢。原生重试也实测了请求 cutoff 与较旧 BC 缓存 cutoff 不同仍能完成，以及同一 task 下一次尝试刷新来源水位、实际模型请求正文包含新输入。

公开声明通过 **strict NodeNext + `--skipLibCheck`**（既有第三方声明依赖限制保留）；**18 份 SQLite 数据库**完整性/外键检查通过，中心仍仅存设备注册。**7 个最终服务 exit 0**，验收夹具进程全部清理、剩余 0；没有新增仓库测试，所有夹具与证据留在仓库外。

**限制保留。** 未验证物理跨设备/WAN、Linux、Android、arm64、Tauri/TUI 或真实智能/付费模型；未穷尽直接 JS 参数/AbortSignal 并发矩阵及每个 close-beforeRequest 微观交错。reply 先于 request 的场景用受信收件 CLI 模拟，不是网络认证证据；发布恢复是“原生结果存储故障 + 强杀”，不是无故障提交间隙的精准崩溃，也不证明任意外部副作用 exactly-once。旧模块的连接负载/中继反压等未实测项继续保留。

沉默仍可能花费推理。N 个 Bot 对一条人类消息各判断一次，随后 F 条 Bot 发言都立即唤醒其余成员时，决策数约为 N＋F×(N−1)，还未计工具、压缩和重试。合并、去重、沉默和明确停止减少无效唤醒，不能因此承诺零成本；已测并发收件的旧稿防护不代表持续高负载下的成本与延迟已完成调优。

### 一个具体片段

用户在群里问“手机截图上传方案有什么风险？”Windows Bot 甲和 Android Bot 乙的 Host 都先保存消息。甲查资料后公开指出隐私风险；乙正在查本机权限，收到甲的发言先合并，发布前不再重复同一意见，只补充后台限制。乙也可 silent，群里不出现沉默通知。

甲随后私聊乙询问“这台手机当前是否授权 Shower？”，乙用相关回复回答；双方 DM 保存该问答，甲不自动回 ACK。甲若要告诉群成员，另发一条获准公开的结论。乙断网时请求留在甲的 outbox；重连重复投递只保存一次，回复保持原关联。用户此时通过本机 `stopWork` 停止选定 Bot/scope，Host 确认后该范围停止；其他成员不被假称已经停止，之前取得的截图也不被假称撤销。之后须显式 `resumeWork` 才解除该范围的 owner 停止。

## 6. 记录归属、可靠投递与历史

各 Bot Host 保存自己收发的公开群事件、双方 DM、自己的私有执行状态。多个 Bot 同 Host 可共享不可变事件存储，但可见性、投递和处理状态仍按对话/成员区分。中心不存聊天库，也不以某个成员作为永久群记录宿主。

最小事件包含 messageId、认证作者、来源 Host/流及序号、群或 DM 范围、成员修订/目标集合、消息类别、rootId、replyTo、正文和附件引用、展示时间。作者由认证会话确定；重试 ID 与正文固定，同 ID 不同内容应拒绝。成员修订固定当次接收范围，不因后来入群自动重投旧消息。

来源 Host 把消息及目标 outbox 持久保存后发送，接收 Host 去重落盘后 ACK；中心转发成功不等于成员收到。来源保留各目标确认状态并重试，接收去重与“已进入推理输入”的水位都要持久化，避免重启再次触发旧消息。附件按引用与权限读取，未下载或来源离线时明确不可用，不因有消息正文就声称附件齐全。

纯客户端发群消息时，可选一个在线成员 Host 受理**这一条**并负责 fanout。受理回执只证明该 Host 已保存，不代表全员同步，也不会把它提升为永久群主机；全员离线则留客户端待发。已受理但其他成员离线时展示待投递，不能让中心冒充离线 Host。

历史 API 按群/DM、消息 ID 和 Host 局部 cursor 分页，返回来源、连续序号水位、缺口与更新时间。cursor 不能跨 Host 复用。客户端可从在线副本补缺，仍要标明离线、陈旧和缺口；一次查询成功不代表所有来源已同步。无在线副本时只能等待，不能凭中心补出不存在的历史。

**主私聊实时预览**（模块 6）是瞬态进度，不是可靠记录：经认证本地 SSE 被动订阅有界投影，先交付完整快照，再接收整体替换式更新；sequence 只在单订阅内单调递增并可跳号，不是持久游标或 ACK。断线只停止观察，不中止 Agent；完整原文始终走分页历史 API。该模块仅覆盖主私聊，不提供群消息传输，也不代表中心或 Tauri 已就绪。

保留作者顺序与 replyTo 因果；并发事件用确定性显示规则，允许不同 Host 暂时显示不同前缀。不依赖墙钟构造全局强一致，也不引入完整 Matrix 联邦、签名 DAG 或共识。新成员默认从加入边界开始；历史分享是用户明确可选的范围导入，记录来源和实际范围，导入不逐条唤醒旧消息。

### 模块 7：本机持久消息账本已实现

模块 7 把上文“记录归属、可靠投递与历史”中的**本机记账部分**落地：`messages.sqlite`（user_version=1）保存作用域/成员修订、不可变信封、outbox、接收去重 ACK、本地收件/历史/缺口，并提供特权离线 CLI。它仍只在本机，**不包含**网络认证、隧道、中心、HTTP 入口、LLM 调用、推理、唤醒或 UI。不要据此宣称跨设备消息已收发或网络能力已就绪。

关键机制与设计约束：

- **DM 参与者固定**：同一 DM scopeId 的两个 Bot 不随修订替换，另一对 Bot 使用新 scopeId。群成员通过不可变修订更新。
- **修订源流**：源流按 (scopeId, revision, sourceDeviceId) 划分，`streamId='scope:'+sha256(JSON.stringify([scopeId, revision]))`；成员修订变化开启新流，新成员不会因从未面向它的事件产生假缺口。
- **冻结 targetSnapshot**：信封 targets 是整份规范成员列表，随消息固定，不由调用方选择；成员修订固定当次接收范围，不因后来入群自动重投旧消息。
- **同 ID 冲突与重试**：publish 同 ID 同发布指纹返回原消息（重试安全），指纹不匹配或与已接收 ID 冲突报 REQUEST_CONFLICT；receive 同 ID 异 digest 或 source+stream+seq 复用冲突同报。
- **per-Host ACK 不进聊天**：ACK 是投递层确认，持久由 stored_at+digest 派生，重复 ACK 不产生状态/事件；绝不作为聊天消息进入收件/历史。
- **本机历史游标**：history 按本机 local_id 升序分页（接收顺序，非全局时间线），cursor 仅限本机/同 scope；missingRefs 读取时计算，晚期引用到达可消缺，不改原信封；streamStatus 缺口只到最高观测序号，最多 100 个最早缺口区间。
- **特权离线 CLI peer 断言非认证**：receive/ack 的 peer 是可信进程内调用方断言上下文，不是密码学认证实现，也不是模型选项；无 --force 信任绕过，无自动投递/重试/轮询/LLM。
- **落盘≠推理**：inbox 落盘只是回执，不等于已推理；无自动响应或请求合成。人类作者保留：user 仅 room public，经含成员 Bot 的 Host 发布；bot 间 DM 不允许 user；未来模型工具必须注入自己的 bot actor，不信模型自报作者。现有 Host 控制 SSE 仍是主私聊通道，模块 7 不改当前 token 路由。

模块 7 已在 Windows x64 / Git Bash、Node 26.8.2 与 Node 22.19.0 完成 278 个端到端检查点及公开类型检查。使用四份本机 Host 数据目录验证持久消息、并发去重、ACK、乱序缺口、成员修订、事务回滚与旧数据保护；信封经特权离线 CLI 传递，尚未接入网络认证和跨设备传输。完整范围与未验收项见 [host-core/README.md](../host-core/README.md)。

### 模块 8：认证设备中继与 Host 消息投递已实现（中心只存注册）

模块 8 落地轻中心第一阶段：`relay-server` 只保存设备注册（`relay.sqlite`：device_id/token_hash/credential_version/created_at/updated_at/revoked_at）并中继认证 WebSocket 帧；`device-link` 是 Host 侧客户端，复用模块 7 持久 outbox 完成真实本机进程网络端到端投递。**没有**全局 Bot 目录、聊天库、模型凭证、通用 URL/端口/VPN 转发；没有 LLM/群决策/UI/远程控制 RPC；也不宣称端到端密码学（TLS 通道认证是唯一信任来源，无 E2E 加密签名/PKI 声明）。

关键约束：

- 设备凭证由本地所有者 CLI 预登记（token 仅环境变量，入库 SHA256 哈希，不留明文），无自助配对 UI 或未认证注册端点。撤销/轮换递增 credentialVersion，服务端逐帧 + 1000ms 定时器校验，另一进程的 CLI 修改会在后续逐帧或每秒检查时生效（4403）。
- ws 仅字面回环（127.0.0.1/::1）免 TLS；外部监听必须 TLS。自签 ca 可传但不能关闭校验。Hello 先于一切，Origin 拒绝 403，路径/query 不符 404；新认证连接替换旧连接（4409 → blocked，不重连对抗）。
- 扫描是投递非模型调度：有界在途（16 全局/1 每目标）、1000ms 周期 + wake 扫描、每 tick 一页 200 条、指数退避 1000→30000ms；ready 非落盘 ACK，source pending 保留，latest diagnostic 非全目标状态。
- 中心无聊天库/模型/Bot 目录/全局状态；消息落地仍走模块 7 去重 ACK。
- 模块 8 已在 Windows x64 / Git Bash、Node 26.8.2 与 Node 22.19.0 完成 146 个端到端检查点及类型检查；真实 TLS/IPv6、本机多进程投递、离线补投、撤销/轮换、连接替换、ACK 存储故障及强杀恢复通过。中继数据库只保存设备登记。跨物理设备/外网等尚未验收，完整范围与剩余验证见 [host-core/README.md](../host-core/README.md)。

### 模块 9：认证远程 Host JSON 控制（已完成父助手验收）

模块 9 落地“任意客户端访问任意已授权设备”的第一版控制面：在模块 8 认证中继上，以固定 10 个 JSON 方法（`getHostInfo`/`listBots`/`createBot`/`getBot`/`findByRequest`/`submit`/`getSubmission`/`history`/`abort`/`contextStatus`）远程控制目标 Host 的 Bot 定义、提交、历史与中止。它保持模块 8 的中心职责不变（中心仍只做注册与路由，不存 Bot 目录/聊天/模型凭证），也不替代同设备 Host 的本机控制面。

- **独立多客户端角色**：客户端显式 `role:'client'` hello，与 Host（`role:'host'`，配置控制适配器时带 `controlProtocol:1`）分离；同一注册设备的多个客户端可并存，DeviceLink 仍是唯一主机连接。角色隔离流量，不抬高凭证权限；心跳/凭证扫描覆盖全部认证连接。
- **原 Host 唯一权威**：客户端不打开 host.sqlite/messages.sqlite/device-link-owner 或 Runtime；目标 Host 仍是 cwd 创建、推理、工具与历史的唯一权威与提交点。cwd 不在源端解析，直接透传目标校验。
- **本地与中继令牌分离**：relay 凭证登录中继；`--control-url`/`--control-token-env` 只是本机回环 Control API 的本地令牌（仅字面 `http://127.0.0.1` 或 `http://[::1]`）。传输仍是受信中继 + TLS 通道，不是端到端加密/签名。
- **结果三态**：`not-sent`（未交给目标本地 Control API）、`unconfirmed`（操作可能已接受，不得假定无副作用或静默重试）、`responded`（目标本地 API 已返回成功/失败，不承诺失败零副作用）。应用层幂等依赖显式 requestId/消息 ID 对账，不做自动变更重试。
- **上限**：请求参数与结果 JSON 各 ≤1MiB，整 relay 帧 ≤2MiB；客户端 8 在途/25s、Host 8 活动/20s、全局 128 pending，无正文队列、分片或大结果信箱。
- **边界（本模块不含）**：任意 HTTP URL/路径/头/端口 RPC、中心 Bot 目录/群决策/模型凭证、离线信箱/自动重试、远程 SSE/直播流、设备目录 UI/枚举协议、新模型上下文/群推理/Tauri/TUI/Android 集成。

父助手已在 Windows x64 / Git Bash、Node 26.8.2 与最低版本 Node 22.19.0 下完成 **171/171 个端到端检查点**（失败 0）及公开类型声明检查。验收使用本机独立客户端、中继和 Host 进程、真实 CA 校验 WSS；IPv6 仅覆盖回环 ws 认证与目标离线回执，不代表在线 Host 控制。模型采用 Mockoon OpenAI-compatible SSE，而非真实外部付费模型；Durable/BC 与目标 cwd 的原生 write/bash/grep 则实际运行。这里是业务链路端到端验收，不是 E2E 消息密码学。

验收覆盖 10 个 JSON 方法、同设备多客户端、幂等/cwd/逐 call 身份核对、离线不重放、调用范围隔离、重复/迟到回复与更换 Host、每客户端/Host 各 8 个并发上限、20s 中继超时、RPC 取消不停止 Agent、显式 abort、1MiB 边界、撤销/轮换，以及 Node 22 中继重启和 Runtime 重开。29 个日志/数据库文件的私有标记检查、中心仅存设备注册、Host 数据库完整性与退出清理通过；6 个最终核心进程 exit 0，测试模型服务 SIGTERM/143，验收所属进程已全部退出。

未实测：跨物理设备/外网、Linux/Android/arm64、Tauri/TUI、真实外部付费模型；全局 128 pending、256 连接负载及中继慢接收者反压。直接 JS AbortSignal、客户端本地 25s 超时兜底和恶意服务端同一 chunk 合并帧拒绝等分支仅由父助手源码核对，不能记作实跑通过。验收数据、脚本、夹具与 `module9-verification.json` 均在仓库外，完整范围见 [host-core/README.md](../host-core/README.md)。

### 模块 12：成员范围管理与历史补齐（已完成父助手验收）

模块 12 把上文“记录归属、可靠投递与历史”扩展为受控的成员元数据与副本补齐：托管 scope 只有**创建 Host** 一个元数据写入者，它不是群日志宿主；成员 Host 保留各自独立消息副本，可在权威离线时互修历史。父助手已在 Windows 本机 Host A–E、Node 26.8.2/22.19.0、真实 TLS/WSS 与 HTTP/CLI 下完成 **122/122 个检查点**及公开声明检查（模型回归使用 Mockoon 脚本化 HTTP/SSE 夹具，非付费/智能模型验收），进度推进至 **12/20**。剩余平台与覆盖限制见 [Host 核心模块 12 说明](../host-core/README.md#模块-12成员范围管理与历史补齐已完成父助手验收)。

- **权威与 CAS**：`createScope`/`updateScope` 幂等去重；更新必须由 authority 以 `expectedRevision` CAS 递增，kind/DM 不可变；旧修订定义/消息/targets 永不改写；元数据 ACK 为收据而非消息/推理完成；正常本地修订保留真实 pending/acked，仅全部 ACK 或合法本地空目标集报告 `fullyAcknowledged:true`。peer 恢复修订若缺本地操作/收据记录，`delivery=null`（isAuthority 仍 true），不推断目标/ACK。
- **已知 peer 授权**：注册外部者不能凭猜 scopeId 获取；初始元数据必须直接来自 authority offer，已知 peer 只能在已记录 authority 下提供历史修订；per-revision 要求服务 peer、请求方与 source 都是成员，冻结 Bot 目标保留——新加入 Bot 不获得未面向它的旧历史。
- **有界补史**：副本同步泵最多 4 个活跃 `(scopeId,peerDeviceId)` 修复任务、每 peer 至多 1 个在途请求、5s 超时、限 256 条冷却，分页遍历本地 scope/peer，页边界轮转；稀疏缺口用 SQL 定位且同 pass 不重求同一缺口；`recordReplicaScan` 只记录请求区间扫描时间，空观察不代表全局完整/在线。
- **自源恢复**：来自 peer 的本机源历史重建发布指纹（仅补空）并恢复丢失的远端 outbox（保留已 ack），后续本地发布沿用最高序号+1。
- **scopeProtocol:1 升级与信任**：先升 relay；已协商源向在线未协商旧目标发 scope 帧回 UNSUPPORTED，未协商/旧源发 scope 帧被 REVOKED 关闭；ready 缺能力→UNSUPPORTED_SCOPE_PROTOCOL，真旧 relay 可能以 BAD_FRAME 拒绝扩展 hello；新连接要求协商；认证通道+TLS 信任服务 Host，无原始作者端到端签名/加密声明。
- **六个本机入口**：GET/POST `/v1/scopes`、GET `/v1/scopes/:scopeKey`、POST `…/members`、POST `…/messages`、GET `…/replicas`（`scopeKey='~'+encodeURIComponent(scopeId)`），配合 ControlClient/CLI 六个方法与 `--input` 文件入口；默认 50/上限 200 分页、控制≈1MiB/同步≈2MiB 预算；用户消息回执与元数据收据都不是投递/推理完成。六个方法仅本机，远端仍固定 10 方法（截至 M12；M14 v2 起已扩展为 35 个固定方法，见下节）。

### 模块 13：可追溯长期记忆（Hindsight → Pi Durable，Host 侧适配交付）

模块 13 把长期记忆落地为**派生事实**：自动提取的稳定偏好与事实存放在由宿主显式配置的 Hindsight 服务中，可追溯来源、适用范围与纠正，按范围控制共享。已完成 Host 侧适配交付（M13 交付时为 13/20；当前含 M16 为 16/20）。验证环境为真实 Durable/BC/HTTP/CLI/SQLite + 隔离 Mockoon 协议夹具；真实 Hindsight 服务联调未做。

- **版本与外接**：复用 Pi Hindsight **0.13.0** 策略与 REST 客户端 schema **0.9.2**，适配 pi-durable **1.3.0** 生命周期，不直接加载 Pi 扩展；客户端版本不是已验证的服务端版本。
- **显式服务配置与数据归属**：每 Host 显式配置 `options.hindsight {baseUrl, apiKeyEnv?, sharedMemory?}`（apiKeyEnv 仅为环境变量名）；事实提取与检索由该服务执行；本机 `hindsight.sqlite` 仅作适配侧输入跟踪/outbox/召回缓存/来源出处/纠正审计，不是第二个事实引擎；原始 Native Entry 与消息账本历史保持完整。M13 阶段记忆接口仅本机；M14 v2 可经中继有界瞬时转发记忆业务结果。中心仅持久保存设备登记与认证校验信息，不持久保存聊天、工作上下文、记忆正文或模型/Hindsight API 凭证；不继承 Pi 个人/项目/全局 banks、HOME 配置或会话文件身份；URL 绑定固定 endpointHash，防止旧 outbox 静默改投另一端点。
- **私有与共享**：默认私有记忆库按 `(deviceId, botId, target)` 建立，target 为 primary/scope/shared；`sharedMemory` 默认关闭，启用后仅同一 Bot 经本机 API/CLI 或模型工具提交的显式笔记可进 shared，自动转录永不共享；共享需显式选择，当前作用域身份由控制器注入，former-member 读语义沿用既有工作绑定的授权。
- **自动召回与显式工具区别**：自动召回是临时性的，在 BC prepare 后、预算检查前注入且仅限预算内，不写回原生条目或 BC 源；显式记忆工具调用/结果走普通 Durable 工具历史，但排除在自动来源抽取之外。
- **队列与纠正不确定性**：异步受理（accepted）≠ 抽取完成（completed）；稳定 operationId 恢复同一次发布，失败抽取不自动重试，需显式 retry；PATCH 纠正/失效/恢复只改派生记忆并保留审计，unconfirmed 结局不自动回放，仅明确 HTTP 4xx 拒绝判 rejected/responded；仅世界/体验事实可编辑，观测派生。
- **接口**：八个本机 Runtime 方法/CLI（memory-status/recall/reflect/retain/get/source/correct/retry）与八个模型工具（hindsight_status/recall/reflect/retain/get/source/correct/retry）；`memoryStatus(botId, input?)` 的 input 为 `{target?,state?,limit?,cursor?}`，返回分页 job 回执（jobs/nextCursor），游标绑定派生 bank/过滤、不能选另一记忆库，计数全上下文、列表可按 state 过滤。memoryStatus **不创建记忆库、不发起后端请求，但可读取已有库**。
- **关闭顺序**：先启动 Durable close，再取消网络请求并等待记忆调用结束，避免正常关闭持久化任务中止，保留可恢复任务。
- **验收状态（夹具环境）**：Windows、Node 26.8.2/22.19.0，实际运行 Pi Durable 1.3.0 + acp-kernel 0.0.101、本地 HTTP/CLI/SQLite；模型与 Hindsight wire 响应来自隔离 Mockoon 夹具。验证八个本机 API/CLI 与八个模型工具、禁用不建库/配置拒绝、私有与 shared bank 边界、provider 前捕获与仅完成态收集、分页/并发收集、代理对安全重建与 Unicode 预览、BC 压缩与预算内召回、稳定 operationId 与显式重试、纠正审计与 unconfirmed/4xx 映射、schema/设备/端点变更拒绝、关闭保留可恢复任务、2MiB 后端响应拒绝与公开声明严格检查。真实 Hindsight 服务部署/API 互通与语义抽取/召回/reflect 质量**未经联调**。完整开发说明与限制见 [Host 核心模块 13 说明](../host-core/README.md#hindsight-memory)。

### 模块 14：统一 Host 服务与设备接入（已完成父助手限定范围验收）

模块 14 已完成父助手限定范围验收（139/139 检查点），总完成数 **14/20**。它把模块 5 本机控制面、模块 8/9 认证中继与远程控制、模块 10–12 工作上下文/scope、模块 13 记忆整合为统一本机服务，并新增本机设置持久化、远端协议 v2 与客户端待发送/对账。

- **统一本机服务**：`openHostService({dataRoot, token, port?, initialSettings?})` 同进程一个 Runtime + 一个 DeviceLink（绝不 spawn 两进程）；控制监听成功后才连接 relay。`host-service-cli` 默认 serve，`--initial-settings` 用于初始化设置；已有库也接受规范化后相同的 seed，差异报 REQUEST_CONFLICT 且不覆盖已有设置。状态 `getStatus()`/GET `/v1/service` 区分 `phase:'running'`（仅本机）与 `relay.phase==='online'`（远端在线）；connecting/backoff/blocked 不虚报 online/ready。legacy 独立 `control-server-cli`/`device-link-cli` 仍可用。
- **本机设置**：`host-settings.sqlite` schema v1 两张表（identity + 当前行 revision/JSON），expectedRevision CAS；设置 JSON 保存配置本身（URL/模型目录/预算/CA 路径等），仅凭证字段以 env 变量名表示，值不进中继；模型目录白名单无 baseUrl/header/secret。GET/PUT `/v1/settings` 与离线 `host-service-cli settings-get/settings-set` 都可用（离线不启动 Runtime，便于配置错误救援）；更新只下次重开生效，不自动迁移已持久会话 model。
- **协议表**：relay protocolVersion 1、scopeProtocol 1 host-only、controlProtocol 2（35 方法 = 旧十 + 新增 25）；v2 client/link 必须 ready 回显 2，旧 client/host 经 v1 兼容。settings/status 不进远端表，无通用代理；remote listDevices/devices-list wire 投影仅四字段白名单，注册/轮换/撤销仍本地 registry CLI。
- **实时预览**：有界安全完整快照（primary/work 分开，work scopeId 恒定、conversationId null→UUID 一次），8/client、8/host、128 relay，opening 20s 非 lifetime；冷观察不创建会话/推理，取消/断流只结束观察；回环 HTTP 拒 Origin，网页需 native fetch 适配。
- **客户端待发送**：仅客户端 SQLite + owner 锁，显式冻结业务 ID，无 auto flush/reconnect replay；state 含 unconfirmed，先只读 reconcile，missing 后用户显式 send 原 payload；accepted 只 Host 受理，不是模型完成或 peer ACK；sourceDeviceId 与真实作者/role 分离，callId 不是业务幂等键。
- **验收**：Windows x64 / Git Bash、Node 26.8.2/22.19.0、真实本地 HTTP/CLI/TLS/WSS、持久 SQLite、Durable 1.3.0 + BC 0.0.101，模型/Hindsight 用隔离 Mockoon 夹具；139/139 检查点通过、53 份 SQLite 完整性/外键（含故意畸形 schema 夹具）、8 个 Native tasks 终态/0 active、30 个 tail readers 清理、夹具剩余 0；无新依赖/仓库测试。冻结 M13 v1 远程 CLI 与 device-link 桥接端经当前控制服务（位于冻结桥后）调用 `getHostInfo` 通过，不代表整个旧 Runtime 或每个旧客户端场景都冻结验证；无首帧时约 20.159 秒触发超时，合成 Host 协议对端收到对应 live-cancel；活动观察凭证撤销/轮换、旧 token 拒绝/新 token 可用、8-live 容量。
- **未实测保留**：物理 WAN/多机、Linux/Android/arm64、Tauri/TUI 与 native-fetch UI；真实 Hindsight 互操作/语义与付费模型；全局 128-live/256 连接饱和与持续反压；穷举直接 JS AbortSignal/iterator.return/close 与跨代 teardown 交错；真实交互式控制台 SIGINT/SIGTERM 矩阵。类型检查 skipLibCheck 通过，完整检查仍有 genai 缺 `@modelcontextprotocol/sdk/client/index.js`（TS2307），不宣称全量第三方类型检查通过。统一长驻服务不是 OS 服务安装器也不保证始终在线；Android/Tauri/TUI、迁移与现有原生兼容属后续模块。TLS+认证 peer 不等于原作者 E2E 签名/加密；relay 仅有界瞬时转发业务，不持久保存业务正文/工作上下文/模型与 Hindsight API 凭证或运行推理；中心仅持久保存设备登记与认证校验信息（设备 token 哈希/credentialVersion）。

## 7. 外壳与 Android 生命周期

Tauri 提供 Android/Windows/Linux 界面与平台集成，Windows/Linux TUI 使用相同业务协议。桌面 Host 不依附一个窗口或 TUI 连接，关闭客户端不停止 Agent。Android 继续保留原生/Capacitor 宿主，M15 已在应用内运行统一核心，Tauri 外壳迁移仍未开始。

Android 是真正本机 Host（M15 已交付）：Durable、BC、原始历史和模型请求在手机，运行于受监督的独立 Node Mobile 子进程。前台服务仅用户显式开启的 specialUse FGS，无 boot/auto-start/空闲关闭/粘性重启；运行数据在独立 `files/bot-host`，模型凭据在 `bot_host_credentials` SharedPreferences，语音偏好与秘密在 `bot_host_voice`/`bot_host_voice_secrets`。覆盖安装保留包名、签名与既有数据路径。系统电池/后台授权由用户决定，无应用自定空闲休眠；现有 Shower 虚拟屏资源回收也不等于休眠整个 Host。M15 在隔离模拟器中使用合成数据、模型和 ASR 验收；构建用法、验证范围与清理记录见 [Host 核心模块 15](../host-core/README.md#模块-15android-本机-host-与原生能力桥)。

M16（旧数据迁移与 Android 兼容）已完成父助手限定范围验收，总完成数 **16/20**：用户显式导入旧聊天（新 role/cwd/model，被动投影归档，草稿仅手动追加）；新 Host schedule_task（可信 owner、一次 submit、自删除不丢对账）；旧 scheduler 冷启动兼容。模块 17 为下一待交付，M17–M20 尚未实现。详见 [Host 核心模块 16](../host-core/README.md#模块-16旧数据迁移与-android-兼容已完成父助手限定范围验收)。

系统回收、force-stop、断网或 ROM 限制时明确离线，未确认项在来源端保留；应用获得合法运行条件后恢复、补投、校对状态。不保证白名单即可 24 小时可用，不承诺远端总能冷唤醒。Widget 冷态只读快照，不能借“持续接单”扩大成启动 Pi、Shizuku、Shower 或 FGS。

## 8. 数据保护与分阶段迁移

安全边界是同一人的已注册设备：配对与设备凭证安全保存，通道认证加密；撤销设备后停止其访问，本机命令、文件与屏幕动作仍需本机授权。模型凭证留在所属 Host 的私有存储，不交中心；所需对话和工具内容仍会发送给所配置的模型服务。私聊隔离必须在发送前执行，不靠 UI 隐藏已广播内容。

迁移不可破坏的约束：

- applicationId=`com.example.launcherprobe`、包名、原签名不变。保留 `chat` SharedPreferences、`files/chat-attachments`、`files/pi-contexts`、`files/node/.pi/agent`、`files/pi-workspaces` 及旧草稿；新数据库在既有私有应用数据内独立管理，不卸载、清数据或重签名。
- 旧 SDK 会话只读导入，保留原 ID 与新 Bot/conversation 的映射及附件来源；不能宣称旧运行检查点能按 Durable 原样恢复。旧 OAuth 凭证需明确格式适配与验证，不保证原样运行；失败保留原数据并提示重新授权。
- Shower 保留非零虚拟屏、Binder UID 校验及本应用归属，不退回物理主屏。原来每聊天屏幕的归属映射到内部 conversation，不能粗暴每 Bot 一块屏幕；接管、释放与超时边界不因换壳丢失。
- Widget 保留 RemoteViews/XML、普通事件至少 1000ms 尾沿节流、关键状态及时更新、私有 task_widget 冷态快照及时间，不嵌输入框/虚拟屏，不冷启动运行时。
- 导航只在 `gestures.pending_restore=true` 时写 0，读回且 commit 清标成功才完成；不写 1、不改无障碍列表，不扩大恢复契约。应用仍是普通助手，不恢复 HOME、桌面、网格、导航手势或应用切换页。
- **旧定时能力单列兼容**：保留 schedule_task、AlarmManager 定义、执行记录、入口和数据。如何接新版运行及 conversation 映射单独验证；“暂不要新后台任务产品”不授权删除、清除或自动停用旧能力，也不借迁移扩展新定时功能。

建议按四步迁移：①固定设备/Bot/conversation/消息语义及旧数据映射；②验证 Durable＋BC 本机状态与副作用恢复，再接统一 Host 控制面，Android 先复用现有桥；③接框架隧道、跨 Host DM/群投递与历史缺口；④迁 Tauri 各端外壳并完成 TUI。每步先验证数据可读和既有能力，保留旧数据只读入口；不把半迁移状态伪装成全端完成。

## 9. 工程待验证与端到端验收

产品已定的是 B、本机状态、轻中心、单用户、Durable/BC、Tauri＋TUI、长期私聊及保留 Android 能力。模块 1–11 已在各节注明的环境验证部分 Durable/kernel 接缝、原生取消、发送去重和工具链；移动运行生命周期、跨物理 Host 补史及跨平台发布/恢复等仍需继续验收。持续负载下的合并等待边界仍是调优项，不重开 SDK 或运行位置选择。

以下是面向完整跨端产品的后续验收场景，不把上述限定范围结果外推为这些场景已完成：

1. **跨端创建与续用**：手机创建 Linux Bot，Windows TUI 继续主私聊；离线创建只待发，重连丢回执不重复创建。关界面不终止 Agent，工具位置与 cwd 始终正确，中心查不到私有模型凭证。
2. **BC 与副作用恢复**：多次压缩后重启 Host，展开旧 refs 找回原文和纠正来源；模拟工具结果不明，不重复外部动作，旧 SDK 历史可读但不冒充检查点恢复。
3. **自然群聊与 DM**：多个 Bot 全员收件、自主补充或沉默；忙时人类纠正先于旧稿处理；DM 不泄露群中，回复不造成确认循环，处理水位与停止状态在重启后恢复，owner 显式 resume 后再处理未消费输入，新人类输入不自行解除停止；主动停止得到范围明确的回执。
4. **断线与历史副本**：固定 ID 重投、接收去重、缺序补史；全部离线客户端待发，在线副本只能证明已知范围；新成员可选导入不唤醒旧消息，不误报全员同步。模块 12 已完成父助手限定范围验收（托管元数据权威、副本授权补史与自源恢复，见模块 12 一节）。
5. **Android 覆盖迁移**：原签名覆盖更新后聊天、附件、草稿、旧定时记录仍在；FGS/嵌入 JS/SQLite/桥与 Tauri 生命周期实机验证；回收、force-stop、断网显示真实离线并恢复补投，Widget 冷读不唤醒，Shower conversation 归属及非零屏边界不变。

## 10. 行业来源与借鉴边界

- [Pi Durable README](https://github.com/earendil-works/pi/tree/main/packages/durable) 与 [spec](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)：采用持久代理执行机制，不据此承诺外部副作用 exactly-once。
- [Billion Context](https://github.com/ranxianglei/billion-context) / [acp-kernel](https://github.com/ranxianglei/acp-kernel)：采用上游上下文压缩与引用能力，Durable 内嵌适配仍需验证。
- OpenClaw [broadcast-groups](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/channels/broadcast-groups.md) / [ambient-room-events](https://docs.openclaw.ai/channels/ambient-room-events.md)：借鉴全员参与、安静上下文及显式发布；相关能力是 experimental，现有单 Gateway 能力不等于本设计跨 Host 已实现。
- [AutoGen Core Group Chat](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html)：只借收件与推理分离，不带入中央经理选人，也不把教学例子当可靠持久存储。
- [Matrix](https://spec.matrix.org/latest/)：只借消息 ID、副本、补史与历史范围，不引入整套联邦共识。[A2A](https://a2a-protocol.org/latest/)：只参考点对点消息关联，不当作群聊标准。
- [Tauri 移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/) 与 [Android FGS 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)：界定平台接入与生命周期验证范围，不作为全天在线保证。
