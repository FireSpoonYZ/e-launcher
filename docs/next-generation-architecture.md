# 下一代多端 Bot 架构设计

> 状态：目标架构设计，整体尚未实现。[Bot/Host 核心](../host-core/README.md) 已独立实现模块 1 本机登记、模块 2 Durable 长期主私聊、模块 3 内嵌 Billion Context、模块 4 本机工具及模块 5 本机控制面（长期本地 Host 控制 API：基础 HTTP、回环端口、Bearer 令牌认证、拒绝全部 Origin；配套 Node/浏览器兼容客户端）及模块 6 主私聊实时预览（认证本地 SSE：有界快照+整体替换更新、每订阅 sequence 非持久游标，原始历史分页保留；无群消息/中心/Tauri，无轮询或新调度器）；模块 7 已实现本机持久消息账本（作用域/成员修订、不可变信封、outbox、落地去重 ACK、本地收件/历史/缺口、特权离线 CLI；仅 messages.sqlite 本机存储，无网络认证/隧道/中心/推理）；模块 8 已实现认证设备中继与 Host 消息投递（中心只存设备注册，复用模块 7 outbox，本机进程网络端到端已通；跨设备/真机网络验收与完整中心产品尚未完成）。整体通信（框架隧道/中心产品）、跨端与外壳（Tauri/TUI）尚未完成。本文约定产品方向、首版设计默认与工程验证边界，不授权删除现有能力。当前安装、构建及运行行为仍以 [README](../README.md) 为准。

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
- **conversation**：内部上下文与恢复标识。主私聊、每 Bot 的每个群、每对 Bot DM 分别绑定，用户无需创建或切换 Session。

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

**需验证的接缝**是请求投影生成、kernel 状态提交、工具结果入库、重试与恢复的顺序。beforeRequest 不是任意写状态接口；没有已确认可直接套用的官方现成适配，研究中的 PrepareRequest task 也不是现有能力。应通过小原型确定安全提交点，再决定具体代码，不在设计中虚构 API。

Pi Durable 当前为实验性 API；实现时固定 Durable、pi-ai、chord 与 acp-kernel 的依赖版本，状态格式升级应有显式迁移，不能静默重置压缩引用或丢弃旧状态。

记忆自动提取后可查看出处、纠正错误，不逐条要求批准。角色、cwd、能力和允许共享的稳定知识保持连续；私聊事实默认保留原范围，不能把“可供自己推理”混同“可以公开原文”。纠正应更新派生记忆并保留追溯关系，不改写历史。

## 5. 长期对话与自然群聊

### 上下文分隔

人类与每 Bot 的主私聊长期存在；群聊各有该 Bot 的工作上下文；双方 Bot DM 另有工作上下文。切客户端或 UI 不新建 Session。群参与只带公开群事件、角色与获准共享的知识，不将主私聊或其他群全文灌入；私有执行轨迹不是群历史。

Bot DM 使用通知、请求、相关回复的语义，可查历史并允许沉默。请求可产生关联回复，但每条回复不会自动成为新请求，也不自动回“收到”。迟到回复按 replyTo 归回原问题，等待超时不意味着对方停止或需换 ID 重问。DM 仅双方可见；若要把结论带回群，Bot 必须另做公开发送，不能自动转发全文。

### 首版决策流程

```text
收到公开消息 -> 去重落盘 -> ACK -> 加入本 Bot/群待处理输入
                                      |
       自身回声/ACK/系统状态/工具进度 --+--> 不触发新决策
                                      |
                   人类或其他 Bot 公开消息
                                      v
           空闲启动决策；忙时合并排队（每 Bot/群一个当前 run）
                                      v
                    BC 投影 + 本次未处理消息
                                      v
          可用工具查证 -> 明确发送动作 / silent 结束
                                      |
             发布前检查已到新消息 -> 先合并复核，不发旧稿
```

公开消息可靠送达全部成员 Host、落盘并成为各自下一轮输入，不等于每条消息立即请求模型。Bot 独立判断是否发言，@ 和回复是自然提示，不是准入门槛；不增加中央选人模型、全群锁或强一致轮询。同机不同 Bot 也各自保有收件与处理水位。

消息到达正在思考的 Bot 时，不为每条消息立即取消重跑；先保存、合并。发送前比对本机已收水位，若有新增内容，先纳入判断再决定发布、修改或沉默，防止明知已有回答还发旧稿。只对本机已收到的消息负责，不能保证所有 Host 发布前看见完全相同前缀；持续新消息下的合并等待边界需验收调优。

公开发布是明确动作。可拟议 send_public、send_private、silent 等工具名，但它们不是 Durable 内置能力。普通 assistant 文本、推理、工具日志、沉默理由都只留私有执行状态，不自动广播。silent 必须真正终结本轮，不再追加“我保持沉默”。接入 Durable 终止控制时须验证其工具轮规则，终结动作不与继续执行的普通工具混搭；身份与目标由 Host 校验，不信模型自报作者。

每条自动接话保留因果链 rootId，各 Bot/群在本机持久记录自动续聊计数与处理水位。设置可见、可调的续聊上限：到限仍接收和保存消息，只暂停该链自动推理并显示原因。Bot 互相发言、转 DM 或重启不能重置预算；具体阈值以自然度、漏答、重复及费用验收调优，不写死“每 Bot 只能思考两次”。人类新发言开启新讨论链。用户主动停止时终止相关群推理与待自动续聊；离线成员尚未确认停止则明确展示，不回滚已执行工具。

沉默可能已花费推理，不能当成零成本。N 个 Bot 面对一条人类消息各判断一次，随后 F 条 Bot 发言都立即唤醒其余成员时，决策数约为 N＋F×(N−1)，尚未计工具、压缩和重试。合并和续聊边界限制无效唤醒；缓存与 BC 只改善部分输入成本，不能代替触发控制。

### 一个具体片段

用户在群里问“手机截图上传方案有什么风险？”Windows Bot 甲和 Android Bot 乙的 Host 都先保存消息。甲查资料后公开指出隐私风险；乙正在查本机权限，收到甲的发言先合并，发布前不再重复同一意见，只补充后台限制。乙也可 silent，群里不出现沉默通知。

甲随后私聊乙询问“这台手机当前是否授权 Shower？”，乙用相关回复回答；双方 DM 保存该问答，甲不自动回 ACK。甲若要告诉群成员，另发一条获准公开的结论。乙断网时请求留在甲的 outbox；重连重复投递只保存一次，回复保持原关联。人类此时说“先停止讨论”，相关推理停止，之前已经取得的截图不被假称撤销。

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


## 7. 外壳与 Android 生命周期

Tauri 提供 Android/Windows/Linux 界面与平台集成，Windows/Linux TUI 使用相同业务协议。桌面 Host 不依附一个窗口或 TUI 连接，关闭客户端不停止 Agent。Android 可先保留原生/Capacitor 宿主承接统一核心，再迁 Tauri 外壳；迁移期不是第二套永久架构。

Android 仍是真正本机 Host：Durable、BC、原始历史和模型请求在手机。按远程持续接单设计，前台服务、嵌入 JS、SQLite、原生桥及 Tauri 移动插件的生命周期需要真机验证，不能照搬桌面 sidecar。系统电池/后台授权由用户决定，无应用自定空闲休眠；现有 Shower 虚拟屏资源回收也不等于休眠整个 Host。

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

产品已定的是 B、本机状态、轻中心、单用户、Durable/BC、Tauri＋TUI、长期私聊及保留 Android 能力。待验证的是 Durable/kernel 提交接缝、原生终止控制与发送去重、Git Bash 环境、移动运行生命周期、跨 Host 补史与发布复核。续聊阈值、合并等待边界属于设计默认的调优项，不重开 SDK 或运行位置选择。

以下仅提出未来端到端验收场景，本文不新增测试、不报告执行结果：

1. **跨端创建与续用**：手机创建 Linux Bot，Windows TUI 继续主私聊；离线创建只待发，重连丢回执不重复创建。关界面不终止 Agent，工具位置与 cwd 始终正确，中心查不到私有模型凭证。
2. **BC 与副作用恢复**：多次压缩后重启 Host，展开旧 refs 找回原文和纠正来源；模拟工具结果不明，不重复外部动作，旧 SDK 历史可读但不冒充检查点恢复。
3. **自然群聊与 DM**：多个 Bot 全员收件、自主补充或沉默；忙时人类纠正先于旧稿处理；DM 不泄露群中，回复不造成确认循环，续聊预算重启仍有效，新人类输入可重开，主动停止得到范围明确的回执。
4. **断线与历史副本**：固定 ID 重投、接收去重、缺序补史；全部离线客户端待发，在线副本只能证明已知范围；新成员可选导入不唤醒旧消息，不误报全员同步。
5. **Android 覆盖迁移**：原签名覆盖更新后聊天、附件、草稿、旧定时记录仍在；FGS/嵌入 JS/SQLite/桥与 Tauri 生命周期实机验证；回收、force-stop、断网显示真实离线并恢复补投，Widget 冷读不唤醒，Shower conversation 归属及非零屏边界不变。

## 10. 行业来源与借鉴边界

- [Pi Durable README](https://github.com/earendil-works/pi/tree/main/packages/durable) 与 [spec](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)：采用持久代理执行机制，不据此承诺外部副作用 exactly-once。
- [Billion Context](https://github.com/ranxianglei/billion-context) / [acp-kernel](https://github.com/ranxianglei/acp-kernel)：采用上游上下文压缩与引用能力，Durable 内嵌适配仍需验证。
- OpenClaw [broadcast-groups](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/channels/broadcast-groups.md) / [ambient-room-events](https://docs.openclaw.ai/channels/ambient-room-events.md)：借鉴全员参与、安静上下文及显式发布；相关能力是 experimental，现有单 Gateway 能力不等于本设计跨 Host 已实现。
- [AutoGen Core Group Chat](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html)：只借收件与推理分离，不带入中央经理选人，也不把教学例子当可靠持久存储。
- [Matrix](https://spec.matrix.org/latest/)：只借消息 ID、副本、补史与历史范围，不引入整套联邦共识。[A2A](https://a2a-protocol.org/latest/)：只参考点对点消息关联，不当作群聊标准。
- [Tauri 移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/) 与 [Android FGS 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)：界定平台接入与生命周期验证范围，不作为全天在线保证。
