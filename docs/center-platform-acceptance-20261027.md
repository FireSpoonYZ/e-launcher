# 中心部署与三端验收（2026-10-27）

代码基线：中心分支 fe5d0ec，按用户选择合入 f5f7b74（本分支 d5a4af1），修复至 71d4420。父助手直接完成，未派子代理。下列结果均来自本轮实跑。

## 部署

- 管理入口：https://relay.firespoon.cn:3000；WSS 中继：同域名 /v1/link。
- Linux：/home/services/e-launcher，Compose 容器 e-launcher-center，镜像 e-launcher-center:71d4420。源程序 current 指向 releases/20261027-71d4420。
- 管理与中继分别只发布到回环 18443、17691，由既有 Ferron 转发。保留原泛域名证书。
- Docker Hub 构建前端拉取阻塞，部署使用仓库外 Dockerfile.deploy，移除 syntax 指令并使用已缓存 node:22.23.4-bookworm-slim；业务源码与仓库一致。
- Linux Host：e-launcher-host.service，控制端口 6279。Windows Host：D:/services/e-launcher/start-host.cmd，同端口。Android：Redmi K80 / zorn / 24117RK2CC，覆盖安装 ARM64 APK，保留原数据。
- 老中继服务停止并禁用；原注册表保留且已迁入 center-data。回滚备份：Linux backups/pre-center-fe5d0ec，Windows backups/pre-center-fe5d0ec，K80 原数据位于仓库外受限验收目录。
- 中心登录密码保存在服务器 secrets/center-owner-password，密钥与设备凭据在 secrets/，未写入仓库。

## 已通过

| 范围 | 本轮证据 |
| --- | --- |
| 六向跨机任务 | Windows→Linux/K80、Linux→Windows/K80、K80→Windows/Linux，真实模型写文件、读回、回传完成回执；独立读取目标设备文件确认标记。 |
| Bot 协作 | Windows Bot 使用 list_bots、ensure_dm、send_dm，与 Linux/K80 Bot 完成请求、落地文件、关联回复和结果汇总；两端文件为 PEER_LINUX_OK、PEER_ANDROID_OK。 |
| 中心模型配置 | 10 个 provider、77 个模型通过管理 API 导入；默认模型和 Bot 覆盖进入 Host 实际请求。覆盖模型的历史记录由 high 切换到 medium；medium 上游报 model_not_found，随后恢复有效 high。验收 Bot 最终恢复继承全局设置。 |
| Hindsight | 原生插件 1.0.0→1.0.1，三端安装/升级回执、状态及实际服务 recall 通过；只绑定验收 Bot，采用 read-only。Linux Bot 禁用后动作返回 403，重新启用后状态成功。 |
| MCP | 中心托管既有 Grok HTTP MCP，配置凭据后列出 3 个工具；Linux 模型实际调用 grok_list_models 返回 7 个模型。Host 快照不包含该中心托管 MCP 密钥。 |
| Skill | 既有 Ponytail SKILL.md 作为制品下发三端；Linux 模型读取实际受管路径并报告技能名称。 |
| Windows 客户端 | 原生 Tauri 应用实际运行、中心登录、连接配置保存、三端设备/Bot 聚合列表通过；原生桥向 K80 提交任务通过。 |
| 图形操作 | Linux 模型启动 zenity；K80→Linux 与 Windows→Linux 的文字输入截图通过。K80 模型启动设置；Windows→K80、Linux→K80 输入中文标记，独立截图确认。 |
| Android 旋转 | 设置应用转为竖屏后，源尺寸返回 1440×3200，与截图方向一致；按返回尺寸换算点击并输入成功。 |
| 断线恢复 | 停止中心，三端 Host 报告 CENTER_OFFLINE；重启中心后三端自动恢复 ready；Linux 另做一次停中心／启动中心复核，Host 无需重启。 |
| 构建 | Android ARM64 APK、Web、Center Web、Windows Tauri release exe、Linux Center 容器构建通过。 |

验收源端分别使用真实 Windows/Ubuntu CLI、K80 Tauri 原生客户端桥；Windows 客户端界面另行实跑。Linux 不是 WSL。

## 本轮发现并修复

- Docker 镜像遗漏 plugins，中心无法启动。
- K80 原数据 schema v4 与中心分支 v3 不兼容：按用户选择集成对应协作代码，未降级数据库。
- 能力激活回调重入同一生命周期队列，产生死锁。
- 部署回执触发配置通知，导致反复刷新及启动失败。
- Hindsight 迁移使用硬链接被 Android 拒绝：在 Host 所有权与串行激活保护下改用原子重命名。
- Host 错误解析中心托管 MCP 的凭据引用。
- 根目录 Skill 被自身绝对路径校验拒绝。
- Android 旋转后截图尺寸与坐标校验仍用创建尺寸。
- 客户端连接观察错误要求选定 Host，界面连接后立即显示离线。
- 停用能力动作的管理 API 明确返回 403。

## 未完成与限制

- Windows 图形子会话需用户在原生窗口完成认证，本轮尚未完成 Linux/K80→Windows 的图形输入验收；不能将以往验收记录计入本轮。
- Linux 原生桌面客户端 GUI 未在本轮构建/运行；已验证真实 Linux Host、CLI、私有 Xvnc。
- MCP OAuth、Node/stdio MCP、全版本回滚/卸载、长时间压力与物理触摸未覆盖。
- 导入的 antigravity/gemini-3.8-flash-medium 实际上游返回 400 model_not_found；保留目录原项，未将目录全部模型标记可用。
- 模型少量最终回复含 ACP 标签；任务文件内容正确，此显示问题尚未修复。

详细命令结果、私有备份与截图位于仓库外 e-launcher-center-acceptance-1793100557367。目录含受限凭据材料，不应整体上传或提交。验收 Bot 和三种能力实例保留用于复查，未绑定普通用户 Bot。
