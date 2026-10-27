# 实施补充与续行职责

本文件由父助手记录已经明确的最新接线，配合center-platform-contract-addendum.md；不是增加新产品范围。

- 全局停用必须可恢复：manager.enable、POST /api/installations/:id/enable，Operation/Plan action含enable；只恢复实例，不修改各Bot选择。
- MCP OAuth由effectiveConfig.oauth===true启用，仅中心托管HTTP；与显式Authorization/apiKeyRef同时配置报冲突。openCenterServer增加publicUrl来自CENTER_PUBLIC_URL。
- OAuth模块：center-server/oauth/index.js → openMcpOAuth({store,publicUrl})；start({installationId,deviceId,botId})→{flowId,authorizationUrl}，status(flowId)→{status:'pending'|'complete'|'failed',error?}，complete({state,code?,error?})，logout({installationId,deviceId,botId})，getAuthProvider({installationId,deviceId,botId,url})→官方McpOAuthProvider，close()。异步操作返回Promise，status同步。callback路径/api/oauth/mcp/callback。
- openCenterExecution增加oauth参数，对oauth实例使用adaptOAuthProvider。身份校验仍在execution。
- 配置凭证标记format:'credential-ref'。EffectiveCapability.credentialRefs为中心解析的该Bot/实例引用列表；Host不能把整设备秘密映射交给一个插件。center目标引用在中心store.resolveCredential，不发送Host。
- NativePlugin.durableTasks每实例注册一次，名字由插件按installationId定义，不自动改名；perBot贡献不带tasks。
- host.sdk注入原生Durable/Chord值，原生包不运行时import宿主引擎。定义用传入SDK，业务独立依赖照常npm安装。
- 通用Runtime须暴露 core文档访问供插件读取上下文（例如host.documents={PrimaryIndex,WorkIndex,WorkContextState,WorkDecisionState,ContextState}），不注入Hindsight专用服务。Hindsight自己实现记忆逻辑。
- Hindsight可选旧memory RPC兼容通过按动作名查找已启用插件（唯一匹配，否则明确拒绝），核心不固定hindsight ID或创建特殊memory服务。
- HostService npmPath可选；Host依赖npm11.6.2已由父助手锁定。Android显式传既有npm资产路径；桌面打包受管npm路径；仅真正安装时检查路径。
- 父助手已运行root web构建通过；center-web构建因缺api.listActions报TS2339，由admin-shell补，不允许声称UI已通过。
- 当前Linux/Docker环境尚未就绪：本机无Docker/可用WSL，已有SSH目标不可达。先继续Windows真实协议/浏览器/Android验证；不把Compose未运行写成通过。

补充worker只在自己的职责写文件，均使用openai/gpt-6.1-terra:xhigh、独立worktree、静态开发，不执行测试/构建/安装。
