# 多端 Bot 重构路线图

本期交付范围是原 **20 个模块**中的 **19 个**（M19 按用户决定移出本期，模块编号保留）：**1–18 已完成，共 18 个**；**M20 进行中，当前 18/19**（M17 桌面客户端与 M18 Tauri Android 界面均已交付并获父助手限定范围验收，见末节）。模块 12 已通过父助手限定范围的端到端验收（122/122 个检查点，见下文）；模块 13（长期事实记忆）已完成 Host 侧适配交付（验证环境与限制见下节）；模块 14（统一 Host 服务与设备接入）已完成父助手限定范围验收（139/139 个检查点，见下节）。模块按交付范围计数，工时另行评估。此前按依赖滚动细分，完整总数未预先锁定；本表是依据已确认剩余范围整理的交付计划，不是最初就约定 20 个模块。

当前状态：**M19 本期不交付**（按用户决定移出本期，模块编号保留；其原规格保留为历史/后续计划；未验收的 TUI 代码只保存在 git stash `02f1396f`（`02f1396fda08d1b666ca83597ebbcea805c74d28`），仅作未来草稿，**禁止取回或删除**，不计入交付与计数）；**M20 进行中**，已交付 M20-01（手机远端入口 + 限定范围跨设备联调），当前 **18/19**，不得把 M20 或整体记成 19/19。M19 的 TUI 界面/终端快捷键/TUI 续聊验收不再是本期或 M20 的完成条件。M20 另有 REDMI K80 真机限定运行验证（本机 Host + remote client，见末节），不改变计数。

架构约束见 [下一代多端 Bot 架构设计](next-generation-architecture.md)，已交付能力与验收细节见 [Host 核心说明](../host-core/README.md)。保持 **B 架构、单人多设备、中心轻量**：Bot 在指定设备和 cwd 长期工作，中心只做设备注册、认证与业务中继，不保存聊天/模型凭证或运行模型决策。Android 是完整本机 Host，不是远程壳；原签名、旧数据、Widget、Shower 和既有定时能力必须兼容，不新增后台任务产品。M19/M20 的交接要点、建议首版范围、环境与已知差距见 [M19/M20 交接](m19-m20-handoff.md)；M19 移出本期与 M20-01 的当前进度见本文末节。

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
| 15 | Android 本机 Host 与原生能力桥 | 已完成 · 父助手验收 | 手机运行 Durable/BC/存储/工具（Node Mobile 子进程），显式 specialUse FGS，独立路径/凭据/语音命名空间，NDK rg/fd，语音与原生桥；5/5 SQLite、109 任务 terminal、17 submission done 及 8 组旧回归通过，范围见下文。 |
| 16 | 旧数据迁移与 Android 兼容 | 已完成 · 父助手限定范围验收 | 原签名覆盖更新、旧聊天/附件/草稿/SDK 历史映射；Widget、导航恢复、既有 schedule_task/AlarmManager 能力与旧数据兼容；用户显式导入与新 Host schedule_task。16/20。 |
| 17 | Tauri Windows / Linux 客户端 | 已完成 · 父助手限定范围验收 | 以 Bot 为中心的设备目录、主私聊、群聊/DM、待发送与 Host 设置界面，复用固定 35 个 v2 方法与 4 个 Tauri 命令，不持有 Host 生命周期；Windows/Linux 构建与 NSIS/DEB/AppImage 实机运行、关闭客户端不停止 Host 通过，跨设备 Relay/CA 与全格式安装验收归 M20。17/20。 |
| 18 | Tauri Android 外壳 | 已完成 · 父助手限定范围验收 | Tauri 界面运行在独立 `:tauri_ui` 进程（exported=false、WebView 后缀隔离），经私有同 UID Binder socket 桥接默认进程 Host；4 个移动命令与公开 35 方法不变；模拟器实测聊天与关闭 UI 后 Host 继续、无重放且设备数据保留，ARM64 仅构建（其后 M20 已在 K80 真机限定运行，见末节）。18/20。 |
| 19 | Windows / Linux TUI | 本期不交付（编号保留） | 同一 Host 业务协议的终端客户端：Bot/设备选择、对话、实时观察及显式停止。按用户决定移出本期：原规格保留为历史/后续计划，未验收代码仅在 git stash `02f1396f`（仅未来草稿，禁止取回或删除），不在交付树、不计完成；其终端界面验收不再是本期或 M20 的完成条件。 |
| 20 | 跨设备集成、打包与真机验收 | 进行中（本期唯一剩余模块；M20-01 已交付） | 手机远端入口与限定跨设备联调已交付，K80 真机本机 Host 及 remote client 已限定运行验证，跨端创建续聊已按手机→Windows 桌面 GUI 有限验证；Linux GUI 全矩阵、完整故障/BC/DM、全格式安装升级卸载、旧版本覆盖迁移与 16 KiB 设备、真实服务与远端 CI 仍待。完成条件见末节。 |

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

模块 **13** 已完成 Host 侧适配交付。模块 **14**（统一服务与远程/live 接线、本机设置、客户端待发送/对账）已完成父助手限定范围验收（139/139 检查点，见下节），总完成数 **14/20**；模块 **15**（Android 本机 Host）已完成父助手验收（见下节），总完成数 **15/20**；模块 **16**（旧数据迁移与 Android 兼容）已完成父助手限定范围验收（见下节），总完成数 **16/20**；截至 M16 模块 **17–20 共 4 个**仍待交付（M17 后续已交付，见末节；M19 后经用户决定移出本期）：Tauri/TUI 与跨设备打包真机验收。

## 模块 13 当前状态与开发说明

模块 13（可追溯长期记忆：Hindsight → Pi Durable）已完成 Host 侧适配交付（M13 交付时为 13/20；当前含 M16 为 16/20）。Host 侧已通过限定范围验收，进程清理与数据库完整性检查完成。

- **版本**：复用 Pi Hindsight **0.13.0** 策略与 REST 客户端 schema **0.9.2**，适配 pi-durable **1.3.0** 生命周期；客户端版本不是已验证的服务端版本。
- **显式配置与数据归属**：每个 Host 必须显式配置 `options.hindsight {baseUrl, apiKeyEnv?, sharedMemory?}`；事实提取与检索由该服务执行，本机 `hindsight.sqlite` 仅作适配侧输入跟踪/outbox/召回缓存/出处/纠正审计，不是第二个事实引擎；原始 Native/账本历史不变；M13 阶段记忆接口仅本机；M14 v2 可经中继有界瞬时转发记忆业务结果。中心仅持久保存设备登记与认证校验信息，不持久保存聊天、工作上下文、记忆正文或模型/Hindsight API 凭证；不继承 Pi banks/HOME/会话身份。
- **私有与共享**：默认私有 primary/scope bank；`sharedMemory` 默认关闭，启用后仅同 Bot 显式注记可进 shared，自动转录永不共享。
- **自动召回与显式工具**：自动召回为 BC prepare 后预算内临时注入；显式记忆工具调用/结果走普通 Durable 工具历史，但排除在自动来源抽取之外。
- **队列与纠正不确定性**：accepted ≠ completed，稳定 operationId 恢复、失败抽取不自动重试、显式 retry；PATCH 纠正/失效/恢复不改原始历史，unconfirmed 不自动回放，仅明确 HTTP 4xx 拒绝判 rejected/responded；仅世界/体验事实可编辑，观测派生。
- **接口**：八个本机 Runtime 方法/CLI（memory-status/recall/reflect/retain/get/source/correct/retry）与八个模型工具（hindsight_status/recall/reflect/retain/get/source/correct/retry）；memory-status 输入 `{target?,state?,limit?,cursor?}` 返回分页 job 回执，游标绑定派生 bank/过滤，计数全上下文。
- **验证（夹具环境）**：Windows、Node 26.8.2/22.19.0，实际运行 Pi Durable 1.3.0 + acp-kernel 0.0.101、本地 HTTP/CLI/SQLite；模型与 Hindsight 的 wire 响应来自隔离 Mockoon 夹具。验证八个本机 API/CLI 与八个模型工具、禁用不建库/配置拒绝、私有与 shared bank 边界、provider 前捕获与仅完成态收集（120 scope 消息 + 2 回答 → 122 job）、分页/并发收集、代理对安全重建与 Unicode 预览、BC 压缩与预算内召回、稳定 operationId 与失败抽取显式重试、纠正审计与 unconfirmed/4xx 映射、schema/设备/端点变更拒绝、关闭保留可恢复任务、2MiB 后端响应拒绝与公开声明严格检查。真实 Hindsight 服务部署/API 互通与语义抽取/召回/reflect 质量**未经联调**。详见 [Host 核心模块 13 说明](../host-core/README.md)。

## 模块 14 完成范围与验收限制

模块 14（统一 Host 服务与设备接入）已完成父助手限定范围验收，总完成数 **14/20**；模块 15–18 后续已交付（见下文），M19 已移出本期（本期不交付）、M20 进行中（当前见末节）。

- **验收环境**：Windows x64 / Git Bash、Node 26.8.2/22.19.0、真实本地 HTTP/CLI/TLS/WSS、持久 SQLite、Pi Durable 1.3.0 + acp-kernel 0.0.101；模型与 Hindsight wire 响应来自隔离 Mockoon OpenAI-compatible SSE/Hindsight 协议夹具。无新增依赖、无仓库测试或临时脚本。
- **结果**：139/139 检查点通过（失败 0）；53 份 SQLite 完整性/外键通过（含刻意构造的畸形 schema 夹具，一致性不代表被接受）；8 个 Native tasks 全部 terminal、0 active；30 个 tail readers 清理、夹具进程剩余 0。
- **覆盖**：统一服务/离线 settings/CAS/重开/重复 owner、null 与 512KiB 启动边界、缺 memory-env 离线救援、settings 存储错误与关闭恢复；35 个固定 v2 方法（含 8 个 memory 方法）、冻结 v1 客户端与 Host 桥兼容及能力拒绝；primary/work 安全快照、冷被动、null→公开绑定、normal/error 帧结束、sequence/目标/私有字段拒绝、1MiB JSON preflight（含误标 SSE）、8-live 容量；无首帧时约 20.159 秒触发超时，合成 Host 协议对端收到对应 live-cancel；活动观察凭证撤销/轮换、旧 token 拒绝/新 token 可用；pending 离线持久化、同 payload 去重/冲突、显式 send、accepted/rejected 不重连、仅缺失精确重试、本地持久失败与只读恢复、schema 先校验与 owner 锁；EPIPE 观察者关闭后慢模型实际完成、同一 submissionId 69 在统一服务重开后恢复并完成、持久 scope 停止跨重开保留；scope 查询分页/游标与特殊消息 ID、跨 scope 隐藏；relay schema 仅 relay_devices 且无合成业务/凭证标记。
- **兼容性说明**：冻结的 M13 基线 v1 远程 CLI 与 device-link 桥接端配合当前控制服务（位于冻结桥后）调用 `getHostInfo` 通过，验证 v1 客户端/桥接互操作；不是整个旧 Runtime 或每个旧客户端场景都冻结验证的断言。历史“远端仅十方法/远程 work 仅限本机”记录截至对应模块；M14 v2 起远端支持固定 work/memory RPC。relay 仅有界瞬时转发业务，不持久保存业务正文/工作上下文/模型与 Hindsight API 凭证或运行推理；中心仅持久保存设备登记与认证校验信息（设备 token 哈希/credentialVersion）。无通用代理、中心变更邮箱、自动重放或 E2E 作者签名/加密声明。
- **限制保留**：未实测物理 WAN/多机、Linux/Android/arm64、Tauri/TUI 与 native-fetch UI；真实 Hindsight 互操作/语义与付费模型；全局 128-live/256 连接饱和与持续反压；穷举直接 JS AbortSignal/iterator.return/close 与跨代 teardown 交错；真实交互式控制台 SIGINT/SIGTERM 矩阵。类型检查 skipLibCheck 通过，完整检查仍有 genai 缺 `@modelcontextprotocol/sdk/client/index.js`（TS2307），不宣称全量第三方类型检查通过。统一长驻服务不是 OS 服务安装器也不保证始终在线；Android/Tauri/TUI、迁移与现有原生兼容属后续模块。TLS+认证 peer 不等于原作者 E2E 签名/加密。

## 模块 15 完成范围与验收限制

模块 15（Android 本机 Host 与原生能力桥）已完成父助手验收，总完成数 **15/20**；模块 16 已完成父助手限定范围验收（见下节），总完成数 **16/20**；截至 M16，模块 17–20 共 4 个待交付（M17 后续已交付，见末节；M19 后经用户决定移出本期）。M14 历史记录及其验收边界保留。

模块 15 在受监督的独立 Node Mobile 子进程中运行 Pi Durable/BC，经专用 Capacitor 桥与原生工具（含 NDK 搜索工具）接入 Android Host，仅用户显式开启 specialUse FGS；独立数据/凭据/语音命名空间，覆盖安装保留旧路径/签名。

验收限于模拟器并采用合成模型：x64 实际运行、ARM64 仅构建。具体构建用法、8 组旧回归、通知时序与附件 GC 边界以及最终清理证据统一见 [host-core/README.md](../host-core/README.md) 模块 15。

## 模块 16 完成范围与验收限制

模块 16（旧数据迁移与 Android 兼容）已完成父助手限定范围验收，总完成数 **16/20**；M17/M18 后续已交付（见下文），M19 已移出本期（本期不交付）、M20 进行中（见末节）。

用户可在设置的 Local Host / Legacy import 面板列出旧会话，分别选新 role/cwd/model 显式预览后导入；预览生成快照与请求 ID，确认导入后该定义被锁定，输入变更需重新预览。状态查询只读、不恢复写操作；prepared 只有用户显式继续原冻结请求才恢复，completed 则回到同一已导入 Bot。旧聊天经永久归档被动投影，草稿仅手动追加，不继承旧凭据/工具执行。

新 Host 定时任务（schedule_task）仅在该 Bot 主私聊且用户显式启动 Host 后执行：可信持久 owner、修订 CAS、每发生一次最多提交一次并只读对账，离线错过不补发；独立存储与日历资产，公开 v2 方法仍 35。

父已在合成 Windows 私有桥与模拟器完成限定范围验证：SDK 选中分支、草稿分页与 UI、真实 AlarmManager、自删除后 run 继续、范围守卫、所有权与存储边界、冷启动兼容及 11 组旧回归（详见 [host-core/README.md](../host-core/README.md) 模块 16）。不宣称全部 instrumentation 组、ARM64 运行、32 active run 饱和或 100 次实际 create；本模块验收时 Android 仍是 Capacitor/原生 Durable Host，Tauri Android 界面由 M18 交付（见末节）。

## 模块 17 完成范围与验收限制

模块 17（Tauri Windows / Linux 客户端）已完成父助手限定范围验收，总完成数 **17/20**；M18 后续已交付（见末节），M19 已移出本期、M20 进行中（见末节）。本模块只交付 `desktop/` 桌面客户端（Tauri 2 Windows x64 / Linux x64）与 `host-core` 内的纯客户端 Node sidecar，不改 Android，也不新增 Host 方法：仍为 **35 个 v2 控制方法与 4 个 Tauri 命令**（`desktop_request`/`desktop_observe`/`desktop_unobserve`/`desktop_pick_file`，`observe_ack` 仅 Rust 本地流控）。

- **不持有 Host 生命周期**：客户端只管理自身传输、观察订阅与私有 sidecar，不启动/停止/`abort` 外部 Host 或其 Agent；只有用户显式 `abort` 或 `stopWork` 才向目标 Host 发停止请求。冷启动不自动连接，连接是显式动作。
- **对话与状态分离**：主私聊 `LIVE` 预览与原始历史分页分开。工作范围有三种独立来源：work 的 `LIVE` 观察流（推送，不推理）、按需分页的原始历史，以及仅当该成员被选中且在线时对 `getWorkActivity` 的每 1000ms 只读刷新（最多 1 个在途读，显式 `stopWork`/`resumeWork` 期间不发新读，`inactive`/离线/卸载停止定时器，旧读不回退显式结果）。
- **不确定结果不自动重放**：先冻结完整输入、所属目标与业务 ID 再入本地队列（按连接 key 隔离，同一 endpoint 的不同名称档案共用），`unconfirmed` 先只读对账，确认缺失才由用户显式发送；Bot 创建只用 `findByRequest` 对账，scope 创建/更新不虚构 lookup。
- **设置与草稿**：Host 设置按 `expectedRevision` CAS，冲突属已返回（responded）：保留编辑、读取远端新 revision，由用户显式采用新基线后再保存；仅 `not-sent` 可直接修正重试，写入/读回丢失回执（unconfirmed）保持锁直到只读对账并显式选基线。发送流程先冻结完整输入、所属目标与业务 ID，再入队；本地草稿 CAS 清空成功后才发送，清空失败不发送；发送后回执丢失保留冻结记录与原 ID 供对账（编辑框可能已清空），序列队列在暂停（含卸载 force save）时先检查。
- **文件引用不是上传**：原生选择框只产生 `{name, path, size}` 本地路径引用，不存在跨设备上传协议。
- **验收环境**：父在 Windows 与 Linux 本机分别实际运行 debug/no-bundle 构建、Windows Release（MSI + NSIS）与 Linux Release（DEB + RPM + AppImage，未削减 targets）；Windows NSIS 静默安装到私有测试目录后运行并完成合成 Host 任务，MSI 仅以 WiX `dark` 解包核实，未安装；Linux 实际安装 DEB 并运行，卸载后以 `AppImage --appimage-extract-and-run` 运行且配置保留、冷态不自动连接；Windows/Linux 基础 GUI、Unicode/含空格 cwd、900x600 聊天与群聊布局、展开原始历史后发送区可见；Windows 实测关闭窗口与 Node 子进程退出后 Host 仍完成 busy 任务，Linux 分别验证普通窗口与 AppImage 原生关闭后客户端子进程回收且 Host 仍存活（未在 Linux 复现 busy 任务连续性）；9 份客户端 SQLite 完整性/FK、安装版数据目录未检出精确合成 token（profile 名称阳性对照命中）、`localStorage`/`sessionStorage` 均 0 条。
- **限制**：模型响应为 Mockoon 合成 SSE，无付费模型或真实用户配置；本模块未验证 Hindsight 服务（无本模块记忆联调），也未做中继 GUI 联调；GUI 运行验证是各自机器的本机 Host，完整跨设备 Relay/CA、目标切换与全链路压力/交错验收属模块 20；未测 FUSE 挂载、MSI 安装/卸载与 RPM 安装；M18（Tauri Android）已由后续模块交付（见末节），M19（TUI）已按用户决定移出本期、不交付（原规格保留为历史/后续计划，未验收代码只在 git stash `02f1396f`，仅未来草稿，禁止取回或删除）。完整用法、数据路径、安装包输出与错误恢复见 [desktop/README.md](../desktop/README.md)，客户端 sidecar 与本地存储细节见 [host-core/README.md](../host-core/README.md) 模块 17。

## 模块 18 完成范围与验收限制

模块 18（Tauri Android 外壳）已完成父助手限定范围验收，总完成数 **18/20**；M19 已移出本期（不计完成）、M20 进行中（见末节），组成、命令与构建用法见 [mobile/README.md](../mobile/README.md)。

- **不是第二个应用，不搬数据**：沿用现有 APK、原签名/applicationId/数据路径与旧 Capacitor 入口；新增的只是独立进程 `:tauri_ui` 里的 Tauri 界面（`TauriMainActivity`，exported=false、`singleTask`、WebView 数据目录后缀 `tauri-ui`）。普通 `ACTION_MAIN`+`LAUNCHER` 与 `assistant_open_host` 重定向到 Tauri；`assistant_legacy_ui=true` 与带旧 extras 的 Intent 保留旧路由；固定栏只有隐藏/旧会话/设置/旧 Host 待确认/重连五个按钮，`openLegacy` 仅接受 chat/settings/host。
- **为何独立进程**：Tauri Android 正常退出会走到 `std::process::exit`，同进程会杀死默认进程。故 Host/FGS 与旧组件仍由默认 Java 进程管理（其中 Host 在它拉起的独立 Node Mobile 子进程里运行），UI 另在 `:tauri_ui`；私有、非导出、同 UID 校验的 Binder 服务只返回 socket FD，业务走 UTF-8 JSONL，上限为 2 MiB 行、8 个在途普通请求、4 MiB 事件预算、保留 pause/清理通道、25 s 请求与 5 s 绑定截止、按 generation 的投递身份、单一原生事件代理与最多一个等待 ACK 的事件帧。公开 Host 方法仍 **35 个**，JS 侧只有 `mobile_host_request`/`listen`/`ack`/`unlisten` 四个命令。
- **生命周期与 pending**：关闭界面/观察/EOF 只释放本 UI 会话持有的观察与语音捕获，不 stop/abort/resume Host；显式重连只修传输，不重发观察或变更。Tauri 界面的 pending 存在独立后缀的 localStorage（冻结 requestId/文本/语音身份，写成功才发送），旧 pending 仍 sessionStorage，互不迁移、不重放；删除/替换（正常受理回执、已知未派发的语音失败、用户显式本地清除）都先核对持久存储中的原身份与不可变内容，未知结果保留原 ID 供只读对账或显式本地清除；`queued/placed` 回执按 ≥1000 ms、最多 1 个在途只读 `getSubmission` 刷新，隐藏/断开/终态停止。
- **构建前提**：本地需 Node ≥ 22.19；`cargo metadata` 引导只需 Cargo（不需 Android target/NDK）；真正编译 Rust cdylib 的 ABI 构建才需 `rustup target add aarch64-linux-android x86_64-linux-android` 与 NDK。SDK include 片段 `mobile/build/tauri-sdk.gradle` 是生成物且被忽略：`settings.gradle` 在缺失时于配置阶段用 `providers.exec` 同步跑 `node host-core/build-mobile.js --sdk-path` 后再 apply（plain Gradle / CI / `scripts/verify.ps1` 同一引导）；手动先跑仍可用于排查；node/cargo 无法启动时 Gradle 直接报 Exec 失败，否则跑完仍缺片段才报带退出码的 missing 错误。`buildMobileUi` 再按 launcherAbis 构建 Rust cdylib、生成的 Kotlin 与 APK 内 Rust 通知；`android.packaging.resources` 另外只取消 8 个法务文本路径的默认排除并用标准 `merges` 合并（签名/MANIFEST 排除与 `useLegacyPackaging` 不变）。该法务接线已限定验收：删掉生成片段后双 ABI `assembleDebug`+`assembleDebugAndroidTest` exit 0、片段自动重建且字节一致、新 APK 仅多 `META-INF/LICENSE`/`LICENSE.txt`/`NOTICE` 而全部原条目同序 SHA256 一致、4 个 Jackson 2.15.3 依赖的 8 项完整文本在内、zipalign `-P16` 与原签名通过。`gradle.properties` 固定 `org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8`，未设并行上限；`:tauri-android` 与工树不同盘时仅该工程关闭 Kotlin 增量编译，`:app` 保持增量。默认 ABI 仍 arm64-v8a，模拟器用 `-PlauncherAbis=x86_64`。APK 工作流已加 Rust stable + 两个 target 的准备步骤，但**远端 GitHub Actions 仍未实际运行**。
- **验收环境**：保留 userdata 的专用 `emulator-5556`（Android 36/x86_64），`-no-audio` 静音 + 自有可信 HTTPS 合成 ASR；完整 `assembleDebug`+`assembleDebugAndroidTest`（无排除、无 job 上限）exit 0，原证书覆盖安装，Tauri ELF LOAD 对齐 0x4000 与 zipalign `-P16` 通过。实测真实 Tauri 资源/启动/桥、冷启动不拉起 Host/Node 且保留 deviceId 与初始 DB 哈希、Unicode/emoji 聊天、文字与语音回执到 done、关闭/SIGKILL UI 后已受理任务继续且无重放、8 RPC 准入与第 9 个 `RPC_BUSY`、25 s `TIMEOUT`/unconfirmed、8 观察与最多一个等待 ACK 的事件帧、空闲 EOF 只发一条私有 `streamError`、权限与 ASR 取消不串归属、竖/横屏工具栏与键盘视口、固定旧路由与独立 WebView 存储隔离；8 份 DB 完整性/FK 通过（186 任务终态、47 submissions done，M16 为 180/41）、4 导入与 4 个停用定时任务及 6 条既有执行记录保留。
- **限制**：无真机，无付费模型/真实 Hindsight/真实 ASR；ARM64 只构建未运行；未覆盖全部传输饱和/竞态、5 s 绑定故障定时器与全部外观组合。旧回归的 `notifications` 组仍在“立即删除是否清空通知”断言处失败 3 次（M16 起的既有问题，产品与测试未改；调试器暂停下通过但改变时序，不属于普通通过，确切原因未确认），其余 10 组正常通过，不要宣称 11 组全部普通通过。

## 模块 20 当前进度：M20-01 已交付（M20 进行中，当前 18/19）

M20 尚未整体完成，是本期的唯一剩余模块。已交付 **M20-01 手机远端入口 + 限定范围跨设备联调**；M19 已按用户决定移出本期（编号保留），未验收 TUI 代码只在 git stash `02f1396f`（仅未来草稿，禁止取回或删除），不在本交付内，也不作为 M20 完成条件。

- **功能**：手机 Tauri 界面并列“本机 Host / 其他设备”；远端页复用桌面 `App`/`BotChats`/`Scopes`/`PendingPanel`，含连接档案（local/relay，只持久非密字段）、设备目录、明确目标、创建 Bot 与按原 ID 查询、主私聊/room/DM 的聊天与历史、pending；token 与 relay CA 只在会话内存。
- **进程与命令**：远端页走独立 Node Mobile client 模式的 `files/bot-client`（独立 SQLite，与本机 `files/bot-host` 隔离），不启动本机 Host/FGS；私有入口只新增 `clientRequest`/`clientObserve`/`clientUnobserve` 与观察帧 `clientFrame`，已删除 `clientClose`；公开仍是 4 个 Tauri 命令与 35 个 Host 方法。
- **生命周期**：进程单例、UI 关闭/EOF 只释放 child，不停止远端 Agent；本机页与远端页保持挂载、不可见时取消观察与轮询；主动重连清旧 identity，不自动重连、不重放；批量取消用 owned 8 槽 + 串行幂等清理。
- **验收（合成模型，不付费）**：Windows x64 Node 26.12.1、Linux x64（Ubuntu 26.04.1）Node 22.19.0、`emulator-5556`（Android 36/x86_64）。隔离真实 TLS relay 在 Linux，Windows 与 Linux Host 上线；手机 UI 经 CA 认证 relay 创建 Linux Bot、提交 Unicode/emoji/多行到真实 Durable/BC 原始 history 并收到合成 SSE 回复；UI 进程 SIGKILL 后 clientNode 退出且已受理任务仍完成；Windows debug GUI 经同一 relay 续聊手机创建的原 Bot；CLI 建立 Windows/Linux 共用 room 与 DM，元数据传播与 room 持久 ACK 通过（不宣称完整自然群聊智能行为或 DM 对话已测）。8 路 primary LIVE 各取 snapshot、8 句柄并发 close 后再开 8 路再关闭通过（真实手机桥，不是纯 mock）。
- **构建**：`npm run mobile:web`、`npm run build`、`node host-core/build-desktop.js --web`、Windows `desktop:build -- --debug --no-bundle`、最终双 ABI `assembleDebug`+`assembleDebugAndroidTest`（40 s）、apksigner 与 `zipalign -P16` 通过；无新增测试。一次桌面重建因自有测试 exe 占用文件失败，关闭后成功，不是代码失败。
- **未完成/不计通过**：Linux GUI 全矩阵、完整故障与 BC 恢复、DM 智能、多格式安装升级卸载、ARM64 旧版本覆盖迁移与 16 KiB 页设备（K80 已限定运行，见下条）、真实 Hindsight/ASR/付费模型、远端 GitHub Actions；本轮不 push、不启动 CI。跨端创建续聊已按 手机创建 Bot → Windows 桌面 GUI 经 relay 续聊验证（有限范围，TUI 客户端已移出本期，不计待办）。`notifications` 普通检查本次基线通过一次，stage1 新 APK 仍在 historical deleting clears notification 断言失败，未改产品或断言，不宣称修好；K80 本轮未跑 `notifications` 组，也不宣称该回归已修。
- **K80 真机限定运行（本轮新增，仍不计 19/19）**：REDMI K80 / 型号 24117RK2CC（Android 16、arm64-v8a、页 4096，旁置 K90 未操作）。同 APK（sha256 `2b50fccfaef5b1da5f8f47777fe4aea30b91f90d57af9a123e78443be52bba39`）先首次安装（安装前设备无此包，故不是旧版本真实用户数据迁移验收），再覆盖重装 `-r`；冷启动无 Host Node/FGS，显式启动后真实 ARM64 Node + specialUse FGS 运行，本机 Bot 中文/emoji/多行写入真实 Durable/BC 历史并取回合成 SSE 回复；UI 进程被 kill 后默认进程与 Host Node 同 PID 保持、重开读到持久回复（关闭前受理回执未捕获，不写精确 busy 接纳时序）；打开“其他设备”后 Host/client 两个 ARM64 Node 并存且 client 用独立数据目录；经真实 CA TLS relay 连 Linux Host，提交唯一 K80 marker 多行消息并在 Linux 原始历史读到输入与回复；8 路 LIVE 各 snapshot、批量 close 后再开 8 路再关闭通过；设置页显式重连后 client Node 退出、本机 Host 同 PID 继续且 UI 无循环；清空合成配置/alias 并停 Host 后覆盖重装，Host state + client store + shared_prefs 字节一致、7 份 SQLite integrity/FK 通过，重开冷态无 Node；无崩溃 buffer 条目。页为 4 KiB，不宣称 16 KiB 设备实测；手机 UI × Windows Host 仍未测（本轮是手机 UI → Linux Host + K80 本机 Host）。证据：仓外目录 basename `e-launcher-k80-1792825796727` 的 `k80-verification.json`。
- **K80 收尾**：App 与测试会话保留在 K80 供查看；本机 Host 已停，`runtime.providers=[]`、`defaultModel=null`、`relay=null`（revision 3）、`credential_aliases={}`；`POST_NOTIFICATIONS` 临时授权后已恢复 false；adb forward 19230 / reverse 18929 已删；自有 Linux Host/relay/Mockoon/SSH 转发/CDP 终端已停；未改电池/自启/无障碍/HOME；未涉及付费模型/真实 ASR/Hindsight。
- **首轮模拟器/桌面收尾（已完成）**：最终窗口、client Node、自有 Windows/Linux Host、relay、Mockoon、SSH 转发、3 个自有终端与模拟器均已停止；userdata 与 fixture 记录保留，自有 adb 19220 forward 已删；该阶段未操作物理设备。不外推其他 M20 项。
