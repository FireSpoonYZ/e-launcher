# Session Bots：develop 集成

此实现以 `develop@2d76462` 为基线，已把原补丁的工作台接入 Android。入口为聊天页标题栏的机器人按钮，以及设置 → 机器人；路由 `/bots/:sessionId?`。头像、角色、定时任务和聊天数据来自原生服务，浏览器没有插件时明确报错，不使用演示数据代替。

## 调用链

```text
BotWorkspacePage → NativeBotUiAdapter → Capacitor Bots
                                         ├─ workspace() → BotWorkspace / ChatStore / ScheduledTasks
                                         └─ uiAction() → 原生用户操作
Pi runtime 的 bots 工具 → PiAgentBridge（绑定当前请求与会话）→ BotManager → BotMailbox → ChatCoordinator
```

原补丁的断点是：前端注册 `SessionBots`，APK 只注册 `Bots`；前端需要全局工作台投影，原生仅返回当前 bot 的设置；头像和简介没有原生存储；跳转完整聊天只改 URL、不选择会话。上述断点已接通。原 `Bots.snapshot/action/saveProfile` 仍供高级设置面板使用。

## 行为与边界

- 一个 bot 对应一个 ChatStore 会话。工作台选择和查看协作不切换原生当前会话；用户点击完整聊天后才调用 `Chat.selectConversation`。创建、发送都不清空其他会话草稿。
- `user / bot / assistant / routine` 来源由原生构造。协作视图按发送者和接收者 ID 筛选；普通助手输出不自动转发。bot 需显式调用 `send` 或 `reply`；回复由原生校验其原消息与发送者身份。
- 投递持久化、同会话串行执行，用户输入优先于尚未执行的 bot 输入。进程中断标记为 interrupted，不自动重放结果不确定的操作。队列、记录数和协作链有上限。
- 头像、简介、名称、角色共用 revision 校验。模型仅能改自己的角色和任务，不能调用 UI 的归档或删除操作。角色修改下轮生效；不删除聊天历史。
- 定时任务在所属 bot 的原会话执行，支持每天、每周、每月，跟随手机时区。保存不运行；立即运行、停止、删除均有独立用户操作。停止取消当前生成和相关待执行消息，不中止其他 bot 已开始的工作，不删除任务定义。
- 工作台显示文本与协作。完整 Markdown、附件、语音、问卷交互、模型设置和工具详情仍使用原聊天页。没有历史时间戳的旧消息显示“历史记录”，不伪造精确发送时间。
- `pi-runtime/session-bots/` 是补丁保留的离线参考实现及测试，**不注册进 APK，不作为第二套调度器**。实际运行的模型扩展在 `pi-runtime/extensions/session-bots/`。

## 验证命令

```sh
npm ci
npm --prefix pi-runtime ci
npm run build
# 设置了 HTTP 代理时，localhost 测试服务必须绕过代理。
NO_PROXY=localhost,127.0.0.1,::1 npm --prefix pi-runtime test
node --test tests/session-bots/*.test.mjs web/test/bots/*.test.mjs
bash scripts/check-session-bots.sh
./gradlew :app:testDebugUnitTest --no-daemon --console=plain
node scripts/build-bots-preview.mjs build/bots-preview.html
python scripts/check-bots-ui.py --chromium /path/to/chromium
```

Android 构建需要 JDK 21、Android SDK 和仓库约定的共享开发签名。单元测试与浏览器测试不等于真机验证：后台省电、系统闹钟、真实模型工具循环仍需在安装后的设备上验收。临时生成的验证签名不能覆盖已安装的共享签名版本。
