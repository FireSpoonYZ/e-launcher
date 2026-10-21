# 多端 Bot 重构路线图

当前交付计划共 **20 个模块**：**1–14 已完成，共 14 个**；**15–20 待交付，共 6 个**。模块 12 已通过父助手限定范围的端到端验收（122/122 个检查点，见下文）；模块 13（长期事实记忆）已完成 Host 侧适配交付（验证环境与限制见下节）；模块 14（统一 Host 服务与设备接入）已完成父助手限定范围验收（139/139 个检查点，见下节）。模块按交付范围计数，工时另行评估。此前按依赖滚动细分，完整总数未预先锁定；本表是依据已确认剩余范围整理的交付计划，不是最初就约定 20 个模块。

架构约束见 [下一代多端 Bot 架构设计](next-generation-architecture.md)，已交付能力与验收细节见 [Host 核心说明](../host-core/README.md)。保持 **B 架构、单人多设备、中心轻量**：Bot 在指定设备和 cwd 长期工作，中心只做设备注册、认证与业务中继，不保存聊天/模型凭证或运行模型决策。Android 是完整本机 Host，不是远程壳；原签名、旧数据、Widget、Shower 和既有定时能力必须兼容，不新增后台任务产品。

## 完成与剩余

“完成”只指对应模块在已注明范围内交付并通过验收，不代表跨平台或完整产品已完成。模块 1–10 保留既有完成数字、结论与限制；模块 11 的完成依据是父助手实际运行的 161/161 个检查点及公开声明检查，不是仅凭静态代码或文档，具体范围见下文。模块 12 已完成父助手限定范围验收（122/122 检查点及公开声明检查），具体环境与限制见下节。

| 模块 | 目标 | 状态 | 简要验收完成条件（完成项为已达成范围） |
| --- | --- | --- | --- |
| 1 | 本机 Host / Bot 登记簿 | 已完成 · `e278795` | 身份与主私聊记录稳定；幂等、并发创建及事务回滚通过。 |
| 2 | Durable 长期主私聊与恢复 | 已完成 · `848a940` | 输入、历史和回执持久化；同 ID 恢复与主动停止，查询不启动模型。 |
| 3 | 内嵌 Billion Context 压缩与引用 | 已完成 · `eb3388d` | 压缩投影、检索与展开可追溯；原文保留，重试/恢复引用稳定。 |
| 4 | 本机文件、搜索与 Bash 工具 | 已完成 · `ae076dd` | 七项工具在目标 Host/cwd 执行；Windows Git Bash、输出边界及中断副作用回执通过。 |
| 5 | 认证本机控制 API | 已完成 · `be5a35d` | 认证回环控制服务；受理、被动查询与显式停止分离，客户端退出不停止 Agent。 |
| 6 | 主私聊实时预览 | 已完成 · `0007aa3` | 认证本地 SSE 被动输出有界快照/更新；断流不停止 Agent，原始历史保留。 |
| 7 | 持久消息账本、outbox 与去重 ACK | 已完成 · `88e274e` | 本机范围/成员修订、信封、outbox、落地去重 ACK、历史缺口与事务回滚通过。 |
| 8 | 认证设备中继与可靠消息投递 | 已完成 · `64628a2` | 本机独立进程经认证中继投递；离线补投、撤销/轮换及恢复，中心仅存设备注册。 |
| 9 | 认证远端 Host JSON 控制 | 已完成 · `0622b7d` | 固定 10 个 JSON 方法及调用/取消/错误边界；父助手 171/171 检查点及类型检查通过，范围见下文。 |
| 10 | 群与 Bot DM 的独立工作上下文 | 已完成 | 独立 Durable/BC、分页前目标过滤、显式原子导入与水位去重、本机 API/CLI；149/149 检查点及类型检查通过，不自动调用模型，范围见下文。 |
| 11 | 自然群聊决策与 Bot 通信工具 | 已完成 | 主动 resume、独立 scope 决策/持久停止、发布复核与原生 hook 取消、真实 Bot 作者、DM 等待/恢复和有界预览；父助手 161/161 检查点及类型检查通过，含 18 份数据库完整性/外键检查，范围见下文。 |
| 12 | 成员范围管理与历史补齐 | 已完成 | 托管元数据权威/CAS/请求去重、v1→v2 原子迁移、已知 peer 副本授权与缺口补史、自源恢复、scopeProtocol:1 与六个本机入口；父助手 122/122 检查点、42 份 SQLite 完整性/FK、7 原生任务终态、18 BC 快照及公开声明检查通过，环境/限制见下文。 |
| 13 | 可追溯长期记忆 | 已完成 · Host 侧适配交付 | 八个本机 API/CLI 与八个模型工具；自动提取稳定偏好与事实，保留来源、适用范围与纠正，按范围控制共享。真实 Durable/BC/HTTP/CLI/SQLite + 隔离 Mockoon 夹具验证；真实 Hindsight 服务联调未做，无虚构 commit/检查点计数。 |
| 14 | 统一 Host 服务与设备接入 | 已完成 · 父助手限定范围验收 | 常驻服务整合、设备登记/凭证配置、Host 本机模型设置、35 个固定远程业务方法、远端实时预览及客户端待发送/对账接线；139/139 检查点、53 份 SQLite 完整性/FK、8 个 Native tasks 终态及夹具清理通过，范围见下文。 |
| 15 | Android 本机 Host 与原生能力桥 | 待交付 | 手机运行 Durable/BC/存储/工具；复用 Shower、Shizuku、语音与原生桥，验收运行生命周期。 |
| 16 | 旧数据迁移与 Android 兼容 | 待交付 | 原签名覆盖更新、旧聊天/附件/草稿/SDK 历史映射；Widget、导航恢复、既有 schedule_task/AlarmManager 能力与数据兼容。 |
| 17 | Tauri Windows / Linux 客户端 | 待交付 | 以 Bot 为中心的设备、私聊、群聊、设置与附件界面，连接共同 Host 协议与桌面常驻服务。 |
| 18 | Tauri Android 外壳 | 待交付 | 迁移手机外壳与移动插件，衔接原生权限、分享、语音、Widget 入口和后台生命周期。 |
| 19 | Windows / Linux TUI | 待交付 | 同一 Host 业务协议的终端客户端：Bot/设备选择、对话、实时观察及显式停止。 |
| 20 | 跨设备集成、打包与真机验收 | 待交付 | 真实 Windows/Linux/Android 跨设备创建、聊天/群聊/DM、重连恢复、数据迁移、发布包与原生能力验收。 |

## 模块 9 验收依据与限制

父助手的 `module9-verification.json` 记录 **171/171 检查点通过、失败 0**，并完成公开类型声明检查及资源清理。环境为 Windows x64 / Git Bash、Node 26.8.2 / 22.19.0，本机独立进程与真实 CA 校验 WSS；IPv6 仅认证及离线回执。模型为 Mockoon OpenAI-compatible SSE，实际执行 Durable/BC 和目标 write/bash/grep，不是调用真实外部付费模型。可信中继与 TLS 不等于 E2E 消息加密/签名。验收数据、脚本与报告均留在仓库外。

尚未实测跨物理设备/外网、Linux/Android/arm64、Tauri/TUI、真实外部付费模型，全局 128 pending/256 连接负载及中继慢接收者反压；直接 JS AbortSignal、客户端 25s 超时兜底及恶意服务端同 chunk 帧分支仅作源码核对。完整验证方法与边界见 [Host 核心说明](../host-core/README.md)。这些限制不因模块 9、10 或 11 标记完成而消失。

## 模块 10 完成范围与验收限制

父助手完成 **149/149 个检查点，失败 0**，以及公开声明检查和本轮进程清理。环境为 **Windows x64 / Git Bash、Node 26.8.2 / 22.19.0**，本机独立 Host 进程与真实 CA 校验的认证 WSS；模型为 **Mockoon OpenAI-compatible SSE**，非真实外部付费模型。类型检查使用 `--strict --skipLibCheck`；不加 skipLibCheck 时既有上游声明引用的可选模块缺失，本轮未改依赖。

本模块完成的是群/DM **被动工作上下文**：收件/ACK 不等于导入，导入水位不等于已推理。稳定 Bot/scope 绑定独立 Durable UUID/BC，继承 Bot 角色/cwd 与 Host 工具配置，但不复制主私聊、不选择模型、不准备压缩投影、不自动调用模型。最终 **4 个模型请求均为 4 次显式 primary 提交**；没有工作上下文推理，Host A 的 16 个工作上下文共 0 个 tasks。

- **范围与分页**：SQL 沿用 `(scope_id, local_id)` 范围索引，并在分页前用冻结 Bot 目标的 `EXISTS` 过滤，无 schema/索引迁移。旧成员、真实作者、自身回声、迟到引用及 Bot/room/DM/BC 隔离通过；12 个并发 sync 仅导入 30 条交错收件一次，5 页历史得到 30 个不同 messageId。
- **原子恢复与断连**：双消息批次第 2 条 SQL 故障使整页/水位及新绑定/BC 一起回滚；重启后完整补入、再试为 0。进行中强杀只计第 3 次可靠证据（健康 Host、请求体已发、写锁阻塞 health、exit 137/reset 56），恢复后导入 1 条、再试为 0；前两次未证明接纳，不计该场景。已受理 sync 在 HTTP 超时断连后仍可于释放锁后完成；Runtime 关闭期间 WSS 收件/ACK 与工作水位独立，重开须显式导入。
- **本机接口与错误**：四个 work Runtime/HTTP/客户端/CLI 操作复用原运行时。历史游标仅为 `{conversationId, position}`，绑定公开 UUID；共享 history helper 只将已识别原生游标错误映射为 `INVALID_ARGUMENT`/400，真实 SQL 读错保留 `ERR_SQLITE_ERROR`/500。
- **HTTP 路径**：`/v1/bots/:botId/work-contexts/:scopeKey` 的 scopeKey 为 `'~'+encodeURIComponent(scopeId)`；服务端解码一次后要求并仅剥一个 `~`，缺前缀报 `INVALID_ARGUMENT`。`.`/`..`/`~.` 分别为 `~.`/`~..`/`~~.`；JS/CLI 仍收原 scopeId，旧路径不变。
- **原通道保留**：主私聊/SSE 和原远程 10 方法回归通过；远程 `workHistory` 被拒为 `not-sent`，新 work API 仅本机。6 份数据库完整性/外键检查及进程清理通过，中心仍仅保存设备注册。

报告在仓库外：`C:/Users/46040/AppData/Local/Temp/e-launcher-work-contexts-1792552863388/module10-verification.json`。完整 API 与验收细节见 [Host 核心说明](../host-core/README.md)。

未实测：跨物理设备/WAN、Linux/Android/arm64、Tauri/TUI、浏览器 native-fetch 适配集成、真实外部付费模型；直接 JS AbortSignal 与直接 `Runtime.close` 并发调用/关闭竞态（本轮已测 HTTP 断连和进程优雅关闭）。全局 128 pending/256 连接负载、中继慢接收者压力及模块 9 原有限制继续保留。

模块 11 自然群聊决策/发言/通信工具已另行通过父助手验收，不能用模块 10 的结果替代，见下节。模块 12 成员同步/补史已完成父助手限定范围验收；模块 13 长期事实记忆已完成 Host 侧适配交付。远程 work 版本化接线留给模块 14，不新增 Session/UI 产品。

## 模块 11 完成范围与验收限制

父助手完成 **161/161 个检查点，失败 0**，总完成数为 **11/20**。环境为 **Windows / Git Bash、Node 26.8.2 / 22.19.0**，使用 pi-durable **1.3.0**、acp-kernel **0.0.101**；本机独立进程通过真实 localhost WSS 通信，实际模型 HTTP/SSE 进程使用脚本化 **Mockoon** 响应。这是协议与执行/恢复机制的验收，不是跨物理设备或真实智能模型群聊质量验证。

- **主动与被动**：`openRuntime`、M10 get/sync/history/context 和 `getWorkActivity` 不启动自动决策；`Runtime.resume()` 才激活驱动并恢复原生任务。常驻 ControlServer 监听成功后调用 resume，因此会处理合格收件、可能产生模型费用。只使用已安装 scope，不做成员发现/协商。
- **自主决策**：本机每 Bot/scope 独立导入、忙时合并，追平后才起新决策；他人 room public 与 DM request 可触发，自身回声/DM notice/reply 不生成新请求，ACK/工具进度不进聊天。同一决策可多轮工具、多次发布，无中央选人、强制 @ 或思考次数上限。最终 assistant 文本私有，只有通信工具发布；没有 silent 工具或 `SILENT` 字串解析。
- **发布与恢复**：以实际冻结模型请求的来源 localId 水位复核，不拿最新导入水位/tokenCount/native EntryId 代替。`publish(input,guard?)` 的 guard 为来源 `{scopeId,afterLocalId}`，可不同于发送目标；消息事务中核对成员及更晚的冻结目标非自身事件，陈旧输入报 `STALE_INPUT`、无消息/outbox 写入并 replan。合法同 ID/指纹重放先返回已存消息，guard 不进信封/指纹，不改消息 schema。
- **原生 hook 取消修正**：pi-durable 1.3.0 HookRunner 会吞掉普通 beforeRequest 异常。组合 hook 的策略/BC prepare/预算步骤失败且本次 context 尚未取消时，使用同一 invocation context 执行 `harness.abortTask(api.taskId, context)` 后再抛错，只取消当前生成 task，不取消 conversation/队列；已因正常 close 取消时不追加持久 abort。父助手实跑旧稿 replan、零 provider 预算拒绝、工作 schema fatal、主私聊 BC prepare 失败零原文回退及安全等待的关闭/恢复路径。
- **范围明确的停止**：`stopWork(botId,scopeId)` 先持久 stopped，再等待该工作 conversation 中止，不影响主私聊/其他 scope 或撤销已提交消息。`abort(botId)` 仍仅主私聊。重启、全局 resume、新人类输入、重入不解除 owner 停止；仅显式 `resumeWork` 清 stopped/error，且它不单独激活被动 Runtime。退群保留旧目标和未处理输入、停止新推理但不写 owner stopped。
- **DM 与身份**：Host 从真实 conversation 注入 Bot 作者，模型不能自报身份/messageId/guard。`send_room`、`send_dm` 只发送到已安装范围，消息 ID 用持久 task memo 去重；`list_scopes`、`read_scope` 不越过当前成员列表/自身冻结收件。`MessageLog.replies`/`read_dm_replies` 只查自己本机 DM request 的对方直接 replyTo，不按 rootId 泛取或读其他 Bot。`wait_dm_reply` 等首回复最多 30 秒，memo 截止在重放时不延长，先查已有回复再判断过期；timeout 不取消对方，之后继续用原 requestMessageId 读/等。
- **预览不是原文**：通信工具 JSON 最多 50KiB UTF-8，单消息 text 预览最多 4096 Unicode 安全的 UTF-16 单元并标 textTruncated；只按完整条目缩页，游标接在最后实际返回项之后。`list_scopes` 单项转义超限时的前缀分页与 `RESPONSE_TOO_LARGE` 边界见 [Host 核心说明](../host-core/README.md#有界工具预览不等于原文截断)。账本和工作历史原文完整保留；超大模型投影估计达到窗口时 `CONTEXT_LIMIT` 阻塞，不截原文或推进 handled，更小估计仍可能遭 provider 超窗。
- **状态与故障**：`WorkActivity` 包含公开 conversationId/isMember/stopped、导入/处理水位、pending、lastDecision/error；status 优先级 unbound → stopped → error → inactive → thinking → idle，不暴露 nativeId/taskId/cutoff，不充当投递 ACK。模型错误按 scope 阻塞并等待显式恢复；意外存储/schema 错误保留 fatal、停止驱动并暴露，不静默重置。共享 MessageLog 在 harness 关闭后才关闭，DeviceLink 连接/锁独立。

本机接口增量（与 M10 的 get/sync/history/context 四个操作并存）：

| Runtime / ControlClient | 本机 HTTP（前缀 `/v1/bots/:botId/work-contexts/:scopeKey`） | control-cli |
| --- | --- | --- |
| `getWorkActivity(botId,scopeId)` | GET `…/activity` | `work-activity --bot-id --scope-id` |
| `stopWork(botId,scopeId)` | POST `…/stop`，解析后为空对象 | `work-stop --bot-id --scope-id` |
| `resumeWork(botId,scopeId)` | POST `…/resume`，解析后为空对象 | `work-resume --bot-id --scope-id` |

两个 POST 的零字节 HTTP body 沿用 `readControlBody` 约定等同 `{}`，客户端仍发送 JSON `{}`。三者返回 WorkActivity；客户端额外 options 仅 `{signal?}`，取消 HTTP 不撤销已受理操作。沿用 Bearer/Origin 校验、scopeKey=`'~'+encodeURIComponent(scopeId)`（一次解码、剥一个 `~`），CLI 仍用 `--url --token-env`，拒绝无关参数。远端依旧仅 **getHostInfo/listBots/createBot/getBot/findByRequest/submit/getSubmission/history/abort/contextStatus 十方法**，不增加远端 work 或群/DM 直播；接线留给模块 14（截至 M11；M14 v2 起已扩展为 35 个固定方法，见下节）。完整声明、参数与示例见 [Host 核心说明](../host-core/README.md)。

父助手实际运行覆盖无 @ 的独立决策、回声/DM notice/reply 仅导入、最终文本私有、真实作者与防伪、跨来源/目标 guard、旧请求停止后新决策确实发布、来源退群/重入、目标单独拒绝及持久 owner 停止。DM 直接 replyTo 查询排除同 root 下其他请求、自身 reply 与 notice；首回复、超时不重发、迟到回复以及跨 Bot 隐私通过。8 条预览分页各一次，50KiB/Unicode/原文保留及超大单 scope 的前缀与错误边界通过。

- 等待 task **489** 优雅关闭后由 Node 22 恢复原 task 和绝对截止，停机过期不重置 30 秒；发布 task **729** 在消息已提交、原生结果插入遭 SQLite 触发器故障后被 SIGKILL，重开返回同回执，更新输入仍保留且只产生一条发布。
- 原生重试 task **852** 在请求 cutoff **858**、BC 缓存 cutoff **856** 时完成；task **913** 的第 2 次尝试把来源水位 **66 → 67**，实际模型请求正文随之更新。预算阻断保留原文/未处理输入，工作 fatal 与主私聊 BC 失败的隔离、缺模型/配置更新后须显式恢复均通过。
- Host A/B 经真实 WSS 完成脚本化模型 request/reply；B Runtime 关闭时链路仍持久收件/ACK，重开对 notice 只导入。M10 被动接口、primary history/live、空 Host 懒开、所有权、本机 HTTP/CLI 边界和远端十方法回归通过，远端 work 扩展仍拒绝（截至 M11；M14 v2 起已支持固定 work RPC，见下节）。

公开声明通过 **strict NodeNext + `--skipLibCheck`**；既有第三方声明依赖限制保留，不宣称全部上游声明通过检查。**18 份 SQLite 数据库**完整性/外键检查通过，最终无活动原生任务或故障触发器，中心仍仅设备注册表。**7 个最终服务均 exit 0**，全部验收夹具进程已清理、剩余 0。报告：`C:/Users/46040/AppData/Local/Temp/e-launcher-group-decisions-1792558247725/module11-verification.json`；详细行为见 [Host 核心说明](../host-core/README.md)。

明确限制：

- 未验证跨物理设备/WAN、Linux、Android、arm64、Tauri/TUI、外部付费或真实智能模型行为；Windows 本机脚本化协议验收不代表完整产品完成。
- 未穷尽直接 JavaScript 参数/AbortSignal 并发矩阵和每个 close-beforeRequest 微观交错，只记录已运行的等待关闭/恢复与请求前取消场景。
- reply 先于 request 的场景用受信收件 CLI 模拟，不作网络认证证据；发布恢复含刻意注入的原生结果存储失败再强杀，不是无故障提交间隙的精准崩溃，也不保证任意外部副作用 exactly-once。
- 无新增仓库测试；全部夹具与证据留在仓库外。未新增依赖、消息 schema、Android 改动或新的后台任务产品；旧模块的连接负载/中继反压等未实测范围保留。

## 模块 12 完成范围与验收限制

模块 12 已通过父助手限定范围的端到端验收：**122/122 个检查点通过**，完成数为 **12/20**。环境为 **Windows 本机 Host A–E、Node 26.8.2/22.19.0、真实本地 TLS/WSS 与 HTTP/CLI**；模型回归使用 **Mockoon 脚本化 HTTP/SSE 夹具**，不是付费/智能模型验收。验收覆盖：元数据分发/离线 pending/持久与迟到 ACK、同设备多 Bot 目标去重、托管 create/update 幂等与并发 CAS、DM/legacy 边界（Managed bypass 拒绝、legacy 可推进修订）、第三方补史（B 自 C 修复 60 条缺失消息至 61 条总数，页 46+14，原始 source/信封/digest 保留、无伪造 A outbox ACK）、自源恢复（A 自源 61 条信封/digest/发布指纹相同，同 ID 重试原时间、下一发布 sequence 62）、含转义字符的 JSON 精确字节预算与整项前缀、迁移中的 schema 冲突事务回滚与副本整页回滚分别验证、MAX_SAFE_INTEGER 稀疏修复与不安全下一序号拒绝、恢复 authority 修订 delivery:null（已知 pending/acked 保留、本地空目标 ACK 合法）、scope-wire 畸形帧/能力/角色/伪造来源边界、旧 relay 拒新 hello/缺能力阻塞/旧目标 UNSUPPORTED、同 peer 公平调度、stop/resume、被动元数据零原生任务、BC 不准备、超大输入 CONTEXT_LIMIT 零 provider 请求、primary live 隔离、远端十方法回归且白名单未扩（截至 M12；M14 v2 起已扩展，见下节）。

公开声明以 **strict NodeNext + `--skipLibCheck`** 通过；**42 份 SQLite** 完整性/外键通过（含备份/迁移夹具）；**7 个原生任务**全部终态、无活动任务/故障触发器；**18 份 BC 基础快照**的版本均为 acp-kernel **0.0.101**；夹具进程清理完成，relay 仅存设备注册表。

剩余限制：未验证物理 WAN/Linux/Android/arm64/Tauri/TUI；M7–M11 为选定回归而非全量历史场景重跑；M12 高水位/反压分支未单独饱和测试（沿用 M8 共享路径）；未穷尽并发微观交错；原始作者端到端签名/加密**未实现**，当前信任模型是认证通道+TLS 认证 peer；Mockoon 夹具不代表付费/智能模型验收。

模块 **13** 已完成 Host 侧适配交付。模块 **14**（统一服务与远程/live 接线、本机设置、客户端待发送/对账）已完成父助手限定范围验收（139/139 检查点，见下节），总完成数 **14/20**；模块 **15–20 共 6 个**仍待交付：Android 本机 Host/旧数据兼容、Tauri/TUI 与跨设备打包真机验收。

## 模块 13 当前状态与开发说明

模块 13（可追溯长期记忆：Hindsight → Pi Durable）已完成 Host 侧适配交付（M13 交付时为 13/20；当前含 M14 为 14/20）。Host 侧已通过限定范围验收，进程清理与数据库完整性检查完成。

- **版本**：复用 Pi Hindsight **0.13.0** 策略与 REST 客户端 schema **0.9.2**，适配 pi-durable **1.3.0** 生命周期；客户端版本不是已验证的服务端版本。
- **显式配置与数据归属**：每个 Host 必须显式配置 `options.hindsight {baseUrl, apiKeyEnv?, sharedMemory?}`；事实提取与检索由该服务执行，本机 `hindsight.sqlite` 仅作适配侧输入跟踪/outbox/召回缓存/出处/纠正审计，不是第二个事实引擎；原始 Native/账本历史不变；M13 阶段记忆接口仅本机；M14 v2 可经中继有界瞬时转发记忆业务结果。中心仅持久保存设备登记与认证校验信息，不持久保存聊天、工作上下文、记忆正文或模型/Hindsight API 凭证；不继承 Pi banks/HOME/会话身份。
- **私有与共享**：默认私有 primary/scope bank；`sharedMemory` 默认关闭，启用后仅同 Bot 显式注记可进 shared，自动转录永不共享。
- **自动召回与显式工具**：自动召回为 BC prepare 后预算内临时注入；显式记忆工具调用/结果走普通 Durable 工具历史，但排除在自动来源抽取之外。
- **队列与纠正不确定性**：accepted ≠ completed，稳定 operationId 恢复、失败抽取不自动重试、显式 retry；PATCH 纠正/失效/恢复不改原始历史，unconfirmed 不自动回放，仅明确 HTTP 4xx 拒绝判 rejected/responded；仅世界/体验事实可编辑，观测派生。
- **接口**：八个本机 Runtime 方法/CLI（memory-status/recall/reflect/retain/get/source/correct/retry）与八个模型工具（hindsight_status/recall/reflect/retain/get/source/correct/retry）；memory-status 输入 `{target?,state?,limit?,cursor?}` 返回分页 job 回执，游标绑定派生 bank/过滤，计数全上下文。
- **验证（夹具环境）**：Windows、Node 26.8.2/22.19.0，实际运行 Pi Durable 1.3.0 + acp-kernel 0.0.101、本地 HTTP/CLI/SQLite；模型与 Hindsight 的 wire 响应来自隔离 Mockoon 夹具。验证八个本机 API/CLI 与八个模型工具、禁用不建库/配置拒绝、私有与 shared bank 边界、provider 前捕获与仅完成态收集（120 scope 消息 + 2 回答 → 122 job）、分页/并发收集、代理对安全重建与 Unicode 预览、BC 压缩与预算内召回、稳定 operationId 与失败抽取显式重试、纠正审计与 unconfirmed/4xx 映射、schema/设备/端点变更拒绝、关闭保留可恢复任务、2MiB 后端响应拒绝与公开声明严格检查。真实 Hindsight 服务部署/API 互通与语义抽取/召回/reflect 质量**未经联调**。详见 [Host 核心模块 13 说明](../host-core/README.md)。

## 模块 14 完成范围与验收限制

模块 14（统一 Host 服务与设备接入）已完成父助手限定范围验收，总完成数 **14/20**，M15–M20 共 6 个模块仍待交付且未开始任何 M15 工作。

- **验收环境**：Windows x64 / Git Bash、Node 26.8.2/22.19.0、真实本地 HTTP/CLI/TLS/WSS、持久 SQLite、Pi Durable 1.3.0 + acp-kernel 0.0.101；模型与 Hindsight wire 响应来自隔离 Mockoon OpenAI-compatible SSE/Hindsight 协议夹具。无新增依赖、无仓库测试或临时脚本。
- **结果**：139/139 检查点通过（失败 0）；53 份 SQLite 完整性/外键通过（含刻意构造的畸形 schema 夹具，一致性不代表被接受）；8 个 Native tasks 全部 terminal、0 active；30 个 tail readers 清理、夹具进程剩余 0。
- **覆盖**：统一服务/离线 settings/CAS/重开/重复 owner、null 与 512KiB 启动边界、缺 memory-env 离线救援、settings 存储错误与关闭恢复；35 个固定 v2 方法（含 8 个 memory 方法）、冻结 v1 客户端与 Host 桥兼容及能力拒绝；primary/work 安全快照、冷被动、null→公开绑定、normal/error 帧结束、sequence/目标/私有字段拒绝、1MiB JSON preflight（含误标 SSE）、8-live 容量；无首帧时约 20.159 秒触发超时，合成 Host 协议对端收到对应 live-cancel；活动观察凭证撤销/轮换、旧 token 拒绝/新 token 可用；pending 离线持久化、同 payload 去重/冲突、显式 send、accepted/rejected 不重连、仅缺失精确重试、本地持久失败与只读恢复、schema 先校验与 owner 锁；EPIPE 观察者关闭后慢模型实际完成、同一 submissionId 69 在统一服务重开后恢复并完成、持久 scope 停止跨重开保留；scope 查询分页/游标与特殊消息 ID、跨 scope 隐藏；relay schema 仅 relay_devices 且无合成业务/凭证标记。
- **兼容性说明**：冻结的 M13 基线 v1 远程 CLI 与 device-link 桥接端配合当前控制服务（位于冻结桥后）调用 `getHostInfo` 通过，验证 v1 客户端/桥接互操作；不是整个旧 Runtime 或每个旧客户端场景都冻结验证的断言。历史“远端仅十方法/远程 work 仅限本机”记录截至对应模块；M14 v2 起远端支持固定 work/memory RPC。relay 仅有界瞬时转发业务，不持久保存业务正文/工作上下文/模型与 Hindsight API 凭证或运行推理；中心仅持久保存设备登记与认证校验信息（设备 token 哈希/credentialVersion）。无通用代理、中心变更邮箱、自动重放或 E2E 作者签名/加密声明。
- **限制保留**：未实测物理 WAN/多机、Linux/Android/arm64、Tauri/TUI 与 native-fetch UI；真实 Hindsight 互操作/语义与付费模型；全局 128-live/256 连接饱和与持续反压；穷举直接 JS AbortSignal/iterator.return/close 与跨代 teardown 交错；真实交互式控制台 SIGINT/SIGTERM 矩阵。类型检查 skipLibCheck 通过，完整检查仍有 genai 缺 `@modelcontextprotocol/sdk/client/index.js`（TS2307），不宣称全量第三方类型检查通过。统一长驻服务不是 OS 服务安装器也不保证始终在线；Android/Tauri/TUI、迁移与现有原生兼容属后续模块。TLS+认证 peer 不等于原作者 E2E 签名/加密。
