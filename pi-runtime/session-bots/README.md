# Session Bots：离线参考核心

这个目录保留补丁中的纯 JavaScript 状态机、协议及测试。它不注册进 APK，不负责 Android 的真实会话、消息投递或闹钟，也不应与原生调度器同时运行。

生产链路使用 `pi-runtime/extensions/session-bots/` 的 Pi 扩展，经 `PiAgentBridge` 调用 `BotManager`、`BotMailbox`、`ChatStore` 与 `ScheduledTasks`。集成说明见根目录 `BOTS_UI_README.md`。

| 文件 | 离线职责 |
| --- | --- |
| `protocol.mjs` | 消息来源、唤醒提示及角色提示投影。 |
| `core.mjs` | 会话、异步消息、任务和生命周期的纯状态转换。 |
| `host.mjs` | CAS 存储及副作用执行的参考契约。 |
| `extension.mjs` | 参考模型工具，不是 APK 实际加载的扩展。 |
| `public-ui.mjs` | 参考公开快照投影；APK 由 `BotWorkspace.java` 实现投影。 |

运行参考测试：

```sh
node --test tests/session-bots/*.test.mjs
```

这些测试不依赖真实模型或 Android。它们不能代替原生 `BotSessionsTest`、Pi SDK 桥接测试、浏览器交互检查及真机验收。

原补丁研究参考为非官方项目 `b-nnett/grok-bot-0.18-reconstructed`；本目录的参考设计不代表其最新客户端或官方源码。Android 集成不使用该客户端的图片、字体或二进制文件。
