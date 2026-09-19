# 机器人工作台

实际接入说明、行为边界与验证命令见仓库根目录 `BOTS_UI_README.md`。

## 文件职责

- `BotWorkspacePage.tsx`：React 路由及真实 Chat 会话跳转；占满应用安全区域内的可用高度。
- `native-adapter.ts`：调用已注册的 Capacitor `Bots.workspace()`、`Bots.uiAction()`，订阅 `botsChanged`；无插件时拒绝操作。
- `workspace.mjs`：对话、协作、任务、头像/角色编辑与确认对话框。
- `model.mjs`：公开快照校验、来源过滤、稳定头像、消息分组；不依据消息正文推断身份。
- `avatar.mjs`、`bots.css`：八种 SVG 形状、六种颜色、状态动画、移动端面板、深色模式、减少动画设置。
- `web/test/bots/preview-adapter.mjs`：仅供浏览器测试的内存数据，生产构建不导入。

## 原生协议

插件名为 `Bots`。`workspace()` 返回 `{ snapshot, capabilities }`；快照格式为 `{version:1, revision, bots, messages, routines, notice}`。旧设置面板继续使用 `snapshot({conversationId})`，两个方法不要混用。

`uiAction({action,input})` 支持 `sendUserMessage`、`stop`、`createBot`、`updateBot`、`archive`、`restore`、`deleteBot`、`saveRoutine`、`setRoutineEnabled`、`runRoutine`。这是用户界面协议，不是模型工具协议。

Android 的 `BotWorkspace.java` 从持久化状态生成公开投影，不返回认证信息、运行 token、私有 SDK 历史或内部工具参数。`source.kind` 为 user / bot / assistant / routine；普通助手输出明确标为 assistant，只有显式跨 bot 消息属于 bot。`completed` 表示已处理，不代表已经回复。

观察协作不执行操作。双人面板只是用户视图过滤，并非不同 bot 之间的安全沙箱。模型输入由当前会话及宿主来源信息构造，不能将整个 UI 快照发送给模型。

工作台用 revision 防止旧表单覆盖新修改。创建及任务保存失败会显示错误；新建 bot 的初始化失败会执行清理，但这不是跨 SharedPreferences/AlarmManager 的崩溃原子事务。定时任务跟随手机系统时区，不支持独立时区或任意 cron。

原补丁的 UI 是独立绘制实现，不包含 Grok Bot 的原始图片、字体或客户端文件；本次接线不声明与其产品像素一致。
