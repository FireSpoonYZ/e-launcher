# Windows 虚拟屏启动修复与验收（2026-10-27）

修复提交：`2cc9825`。Windows 部署目录：
`D:/services/e-launcher/releases/20261027-2cc9825`，
原生组件：`D:/services/e-launcher/native/2cc9825/shower-windows.exe`。

## 使用方式

首次创建虚拟屏时，在本机完成一次管理员授权，并在“Windows 虚拟屏自动登录”窗口输入当前 Windows 账户密码。密码在子会话登录成功、归属核验和启动归属登记完成后，保存到当前用户的 Windows 凭据管理器。

- 凭据名称：`e-launcher/Shower/localhost`。
- 类型：普通凭据，持久范围为本机当前 Windows 用户。
- 修改或删除入口：控制面板 → 凭据管理器 → Windows 凭据 → 普通凭据。
- Host 运行期间，释放和重建虚拟屏复用已授权组件，自动读取凭据，无需再次输入密码或确认 UAC。
- Host 进程重新启动后，首次创建仍需一次管理员确认；无需重新输入已保存的密码。
- Windows 必须已有交互式用户会话。整机重启停在登录页的场景不包含在本轮验收中。

密码不经过 Node IPC、聊天、工具参数、中心 API、命令行或应用 JSON 配置。原生组件只在本机向 RDP 控件提供密码，清理临时 native buffer；凭据管理器依照 Windows 用户权限保护数据，同一 Windows 用户下的其他进程仍属于该权限范围。

## 修复内容

1. `ShowerCredentials.cs` 使用官方 CredUI、CredRead、CredWrite API，在本机完成输入、验证和保存；无效凭据不覆盖原条目。
2. 已授权 guardian 只处理属于当前 Host PID/启动时间、父子会话和用户的固定执行器启动。令牌核验仍由已有 SYSTEM 临时任务完成，执行器保持普通用户权限。
3. 释放屏幕时保留原生宿主和 ActiveX 控件；Host 退出时由 guardian 清理子会话并恢复系统原值。
4. `WTSLogoffSession` 等待注销完成，避免释放后立即新建碰到仍未退出的旧子会话。
5. 复用控件前等待断开回调结束；初始化桌面时做有界截图探测，避免将 Winlogon 短暂过渡误报为需要输入密码。

未修改 Windows Hello、NLA、RDP-Tcp 或防火墙设置。正常 Windows 子会话应自动登录，但本机 Microsoft 账户环境实测返回 2055；参数变体未解决，最终采用用户明确批准的本机凭据管理器方案。

## 实机结果

- 用户首次在原生凭据窗口配置成功，凭据管理器元数据出现上述条目；未读取或输出凭据内容。
- 同一 Host/guardian 下连续释放、创建新的子会话 14、15，自动登录和执行器启动均成功。
- 重启 Host 后，新的原生进程和 guardian 从 Windows 凭据管理器恢复登录，子会话 16 就绪，未重新输入密码。
- 再由 Linux 与 K80 分别发起释放／重建，子会话 17、18 就绪；第二次桌面过渡较慢，由自动探测等待后完成，无需人工截图触发。
- Linux→Windows 与 K80→Windows 的中文输入、键盘、点击通过。测试应用直接读回 `LINUX_VAULT_FINAL_中文`、`K80_VAULT_FINAL_中文`，点击计数从 1 增至 2。
- Host 退出时，日志记录子会话 15 清理与系统原值恢复成功。

最终构建 SHA-256：
- shower-windows.exe：`3942560e6b107a6544b2f80993778a182b87a135b63150e6dcda4db4ee949360`
- MSTSCLib.dll：`896aabc8b0f846a79b088a62c4f4c75cdaf6550d71cb7a9d5495b04fe6f3cb74`

日志、截图、请求和应用侧读回在仓库外受限目录：
`e-launcher-center-acceptance-1793100557367/windows-startup-fix`。
该目录含私有连接材料，不应整体上传或提交。

## 最终部署状态

最终 `2cc9825` 构建已部署。23:16:07 的首次启动未完成管理员授权，系统返回取消；需要完成当前 Host 进程的首次 UAC，保存的密码无需重新输入。

## 尚未覆盖

Windows 整机重启后无人登录、账户密码更换／过期、长期负载，以及 Linux 原生桌面客户端 GUI 不在本轮已通过项中。

官方依据见 [跨平台 Shower 文档](shower-cross-platform.md#local-windows-credential-enrollment) 中的 Microsoft API 链接。
