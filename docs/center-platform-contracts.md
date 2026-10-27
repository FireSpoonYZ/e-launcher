# 中心平台并行实现契约

状态：本轮共享接口提案，须父助手批准后供各 lane 实现；这里不代表服务已存在或运行验收通过。最终范围以 [reuse-first-development-plan.md](reuse-first-development-plan.md) 为准。除标明已有函数外，下面路径和签名是各 lane 要实现的接口，而不是现有代码。共用线上的 DTO 在 `center-contract/index.d.ts`，协议枚举在 `center-contract/protocol.js`，原生包静态 manifest 使用 `center-contract/manifest.schema.json`（draft-07）。这些文件没有 Node、Android、React 或服务端依赖；前端不得导入 `center-server` 或 `host-core`。

## 一致规则

- JSON 编码，`revision` 是非负整数；CAS 更新要求 `expectedRevision` 与当前修订完全一致，冲突返回 409，不能覆盖。新 Binding 第一次写入时以 0 为修订、`enabled=false, overrides={}`；一次成功写入递增修订。
- global 是唯一基础值；对象递归合并、数组整体替换、null 是显式值。删除 override 的字段即恢复继承。只在中心 data 层调用 deepmerge（`arrayMerge: (_target, source) => source`），合并后以对应 draft-07 schema 校验，初始化安装 global 时才应用 schema defaults。Host 只接收 effectiveConfig。
- 普通管理响应只给 credentialId / configured / revision，不返回秘密。设备快照只能返回该已认证设备实际需要的秘密，存在内存，不写离线业务快照、不记日志。浏览器凭证写入仅使用 HTTPS POST/PUT body。
- 所有安装类副作用请求带 requestId；同一所有者的相同 requestId 和相同请求返回同 operationId，不同内容返回 409。202 仅表示受理；应轮询 operation 和设备回执，不等于已部署。未知外部副作用不能自动重放。
- HTTP 响应错误统一 `{error:{code,message,details?}}`；400 INVALID_ARGUMENT/VALIDATION_FAILED，401 UNAUTHENTICATED，403 FORBIDDEN/CSRF_INVALID，404 NOT_FOUND，409 REVISION_CONFLICT/REQUEST_CONFLICT/INVALID_STATE，413 PAYLOAD_TOO_LARGE，429 RATE_LIMITED，503 CENTER_OFFLINE/DEVICE_OFFLINE，500 INTERNAL_ERROR。错误/日志不得包含凭证。schema 错误可用 details 返回不含敏感值的字段路径。
- `center-contract` 是平台中立的线协议类型，不依赖具体 Fastify/React/Durable 类型；实现模块在其本地使用现有 SDK 类型，不把它们引入共享 DTO。

## 数据与配置（center-data）

`center-server/data/index.js` 导出同步 `openCenterStore({dataRoot, encryptionKey}) -> CenterStore`；`dataRoot` 为绝对路径，密钥由部署环境注入，不存数据库。独立 `center.sqlite`；已有 relay 仍维护其自己的注册库。公开方法均同步，失败抛带 `code` 的错误，`close()` 释放数据库。

```ts
interface CenterStore {
  listProviders(): Provider[];
  getProvider(id: string): Provider | null;
  putProvider(provider: Provider, expectedRevision: number | null): Provider;
  listModels(providerId: string): Model[];
  putModel(providerId: string, model: Model, expectedRevision: number | null): Model;
  getModelConfig(): ModelConfig;
  putModelConfig(expectedRevision: number, global: ModelSelection): ModelConfig;
  getBotModelConfig(deviceId: string, botId: string): BotModelConfig;
  putBotModelConfig(deviceId: string, botId: string, expectedRevision: number, overrides: ModelSelection): BotModelConfig;
  listInstallations(): Installation[];
  getInstallation(id: string): Installation | null;
  getInstallationConfig(id: string): InstallationConfig;
  putInstallationConfig(id: string, input: PutInstallationConfig): InstallationConfig;
  getBotCapability(deviceId: string, botId: string, id: string): BotCapabilityConfig;
  putBotCapability(deviceId: string, botId: string, id: string, input: PutBotCapability): BotCapabilityConfig;
  getCredential(id: string): CredentialInfo | null;
  putCredential(id: string, input: CredentialWrite): CredentialInfo;
  deleteCredential(id: string, expectedRevision: number): void;
  resolveCredential(id: string): string;
  getPackageVersion(packageId: string, version: string): PackageVersion | null;
  putPackageVersion(version: PackageVersion): void;
  putInstallation(installation: Installation, expectedRevision: number | null): Installation;
  getOperation(id: string): Operation | null;
  findOperationByRequestId(requestId: string): Operation | null;
  putOperation(operation: Operation, requestFingerprint: string): Operation;
  listDeploymentReceipts(installationId: string): DeploymentReceipt[];
  putDeploymentReceipt(receipt: DeploymentReceipt): void;
  getDeviceSnapshot(deviceId: string, linkUrl: string): DeviceRuntimeSnapshot;
  close(): void;
}
```

创建 Provider/Model/Installation 时 expectedRevision 为 null，服务生成 ID 和 revision；写入已有项时以 CAS 为准。credential value 为明文写入入口，持久层加密；仅可信服务内部可调用 resolveCredential。操作写入须原子地检查 requestId 和请求摘要。快照在一次一致性读取中生成，不能包含其他设备的 Bot/秘密。模型字段沿用现有 `host-core/runtime-models.js`，迁移时需要兼容其模型和凭证解析，不把明文写到本地 settings。

## 服务组合（center-api）

`center-server/server.js` 导出 `async openCenterServer({dataRoot, encryptionKey, sessionKey, ownerPasswordHash, https, listenHost, port, relay, webRoot}) -> {url, linkUrl, close(): Promise<void>}`。https 为 `{cert: string, key: string}` PEM；relay 为已有 `openRelayServer` 的 `{listenHost, port, tls}`，显式提供外部可达 `linkUrl`（relay 对象中）而不由监听地址猜测。Fastify 管理 HTTPS 和原 relay 两个 listener 共同启动/关闭；任何启动失败需清理已打开资源。入口 `center-server/cli.js` 只读取部署配置并调用此函数。独立模块 `auth.js`、`routes.js`、`host-bridge.js` 由 server 组合，不新造第二套 relay 协议。

浏览器走同源 HttpOnly secure-session；所有修改请求校验 CSRF，登录限速，所有者口令以 scrypt 校验。设备认证复用原设备链路身份；设备权限限自身 snapshot、制品与回执，不继承所有者权限。原 relay Origin 和设备认证规则不放宽。

### HTTP API

除 `/api/session`、登录外管理接口均需 owner session；PUT/POST/DELETE 要 CSRF。下表 `T` 表示 `center-contract/index.d.ts` 的同名 DTO；列表直接返回数组、成功的空操作返回 204。资源 ID 做 URL 编码。

| 方法与路径 | 请求 → 成功响应 |
| --- | --- |
| GET /api/session | → SessionInfo（匿名也可读） |
| POST /api/session | LoginRequest → SessionInfo；登录后发新 session |
| DELETE /api/session | → 204 |
| GET /api/providers | → Provider[] |
| POST /api/providers | Provider（id 可由服务创建，revision=0）→ Provider，201 |
| GET /api/providers/:id | → Provider |
| PUT /api/providers/:id | RevisionWrite<Provider> → Provider |
| POST /api/providers/:id/validate | ProviderCheckRequest → ProviderCheckResult；指定在线设备执行 |
| POST /api/providers/:id/discover | ProviderCheckRequest → DiscoveryResult；指定在线设备执行 |
| GET /api/providers/:id/models | → Model[] |
| POST /api/providers/:id/models | Model（revision=0）→ Model，201 |
| PUT /api/providers/:id/models/:modelId | RevisionWrite<Model> → Model |
| GET /api/model-config | → ModelConfig |
| PUT /api/model-config | RevisionWrite<ModelSelection> → ModelConfig |
| GET /api/devices | → Device[]（取原 relay 在线状态） |
| GET /api/devices/:deviceId/bots | → BotRef[]（在线 Host 查询，离线 503） |
| GET /api/devices/:deviceId/bots/:botId/model-config | → BotModelConfig |
| PUT /api/devices/:deviceId/bots/:botId/model-config | RevisionWrite<ModelSelection>（value 为 overrides）→ BotModelConfig |
| GET /api/credentials/:id | → CredentialInfo |
| PUT /api/credentials/:id | CredentialWrite → CredentialInfo |
| DELETE /api/credentials/:id | RevisionWrite<null> → 204 |
| GET /api/capabilities | → Installation[] |
| POST /api/installations | InstallRequest → Accepted，202 |
| GET /api/installations/:id | → Installation |
| GET /api/installations/:id/config | → InstallationConfig |
| PUT /api/installations/:id/config | PutInstallationConfig → InstallationConfig |
| GET /api/devices/:deviceId/bots/:botId/capabilities/:id | → BotCapabilityConfig |
| PUT /api/devices/:deviceId/bots/:botId/capabilities/:id | PutBotCapability → BotCapabilityConfig |
| POST /api/installations/:id/validate | ProviderCheckRequest → ProviderCheckResult |
| POST /api/installations/:id/updates/check | → PackageVersion[]；只查询，不激活 |
| POST /api/installations/:id/update | UpdateRequest → Accepted，202 |
| POST /api/installations/:id/rollback | OperationRequest → Accepted，202 |
| POST /api/installations/:id/disable | OperationRequest → Accepted，202 |
| DELETE /api/installations/:id | OperationRequest → Accepted，202；默认保留数据 |
| POST /api/installations/:id/actions/:action | ActionRequest → ActionResult；已声明 action，限输入输出及超时 |
| GET /api/installations/:id/deployments | → DeploymentReceipt[] |
| GET /api/operations/:id | → Operation |

设备独立认证接口（不是浏览器管理接口）：POST `/api/host/bootstrap` BootstrapRequest → BootstrapResponse；GET `/api/host/snapshot` → DeviceRuntimeSnapshot；POST `/api/host/receipt` RuntimeReceipt → 204；POST `/api/host/deployments/receipt` DeploymentReceipt → 204；GET `/api/host/deployments` → DeploymentPlan[]；GET `/api/host/artifacts/:artifactRef` → 原始制品字节。服务端从认证身份确定 deviceId 并与 body 一致性校验，按实际分配检查制品，不让设备自行指定其他设备的 snapshot。通知通过现有设备链路触发重新读取完整快照；不把秘密或制品塞进有界控制帧。

## 安装和部署（package-install）

`center-server/packages/index.js`：`openPackageManager({dataRoot, store, npmPath}) -> { install(request: InstallRequest): Promise<Accepted>, update(id: string, request: UpdateRequest): Promise<Accepted>, disable(id: string, request: OperationRequest): Promise<Accepted>, uninstall(id: string, request: OperationRequest): Promise<Accepted>, rollback(id: string, request: OperationRequest): Promise<Accepted>, checkUpdates(id: string): Promise<PackageVersion[]>, close(): Promise<void> }`。串行执行，先持久化 operation；源解析用 pacote，依赖树用固定 npm CLI；HTTP 类型登记 URL 而不声称下载或安装远端服务。中心保存固定 resolved/integrity、制品摘要与 lockfile。校验包路径、归档大小和越界链接；不可信归档不得穿越目录。

`host-core/managed-install/index.js`：`openManagedInstaller({dataRoot, npmPath, fetchArtifact, report}) -> {apply(plan: DeploymentPlan): Promise<DeploymentReceipt>, close(): Promise<void>}`；fetchArtifact 接收 artifactRef 返回制品字节，report 接收 DeploymentReceipt。执行端验证摘要并在受管暂存目录用平台 npm 准备依赖，空闲边界激活；失败保留旧版，忙时报告 waiting-idle。卸载默认保留数据；不复制其他平台 node_modules，也不在 Bot 启动时安装。计划、回执只表达部署状态，不把 202 当作成功激活。

## Host 在线入口（host-center）

`host-core/center-client.js` 导出 `connectCenter({centerUrl, deviceId, deviceToken, onDisconnect, onChange}) -> Promise<CenterClient>`，返回 `{bootstrap(): Promise<BootstrapResponse>, getSnapshot(): Promise<DeviceRuntimeSnapshot>, reportRuntime(receipt: RuntimeReceipt): Promise<void>, getDeployments(): Promise<DeploymentPlan[]>, reportDeployment(receipt: DeploymentReceipt): Promise<void>, fetchArtifact(ref: string): Promise<Uint8Array>, close(): Promise<void>}`。认证与通知复用现有链路，不新造离线授权。设备 token 永不传给浏览器。

`host-core/host-service.js` 保留现有 `openHostService(options)` 导出，由 host-center 改造：先读取设备身份、认证、bootstrap 并获取快照，再准备部署/registry、建立链路、启动 runtime，最后回报 ready。中心断连立即拒绝新工作并经现有取消机制停止在途调用；重连重新读取当前快照、应用后才恢复，不自动重发未确认请求。`host-core/runtime-models.js` 导出 `applyCenterModels(snapshot: DeviceRuntimeSnapshot) -> {models, botModels}`，复用现有模型注册与校验，按引用注入凭证（仅内存）。`models` 为既有 pi-ai registry，`botModels` 按 botId 索引有效 ModelSelection；被禁用/不存在的模型应报错，不自动换模型。

## 插件与驱动（host-plugins、mcp-skills）

`host-core/plugins/index.js` 导出 `loadNativePlugin({installationId, version, entry, dataDir, host}) -> Promise<NativePlugin>`。原生包 entry 导出 `createPlugin({installationId, version, dataDir, host}) -> Promise<NativePlugin> | NativePlugin`；NativePlugin 为 `{forBot(context): Promise<BotPlugin> | BotPlugin, close(): Promise<void>}`。context 为 `{deviceId, botId, installationId, effectiveConfig, credentials}`，credentials 是按有效引用解析的只读映射；BotPlugin 为 `{durableContributions, requestContributions, actions, prepare(), activate(), quiesce(), close()}`，四个生命周期方法均返回 Promise<void>。贡献采用既有 Durable tools/sections/tasks/docs 类型；上下文增强、actions 的具体现有 SDK 类型由 host-plugins 在本模块声明，不重新定义引擎。资源按 Bot 创建复用；全部 direct/nested 工具、后台任务及 hook 在执行入口检查中心在线、实例与 Binding 双开关。Hindsight 作为此契约的普通插件，迁移保留原状态身份。

`host-core/capabilities/mcp.js` 导出 `createMcpDriver({installationId, version, dataDir, host}) -> Promise<NativePlugin>`；`host-core/capabilities/skill.js` 导出 `createSkillDriver({installationId, version, dataDir, host}) -> Promise<NativePlugin>`。两者使用相同 `forBot(context)` 和生命周期；MCP 依 pi-mcp 将工具适配 Durable，Skill 只加载完整受管目录并输出启用 Bot 的 section；必须保留相对资源路径。驱动不得自行合并 global/overrides、绕过策略或将其他 Bot 客户端复用为当前 Bot。

## 管理前端（admin-shell、plugin-ui）

`center-web/api.ts` 导出 `api` 对象，方法命名与 HTTP 操作一致：`session, login, logout, listProviders, getProvider, putProvider, validateProvider, discoverModels, listModels, putModel, getModelConfig, putModelConfig, listDevices, listBots, getBotModelConfig, putBotModelConfig, getCredential, putCredential, deleteCredential, listCapabilities, install, getInstallation, getInstallationConfig, putInstallationConfig, getBotCapability, putBotCapability, validateInstallation, checkUpdates, updateInstallation, rollbackInstallation, disableInstallation, uninstallInstallation, runAction, listDeployments, getOperation`。参数按上表顺序（路径 ID 在前，body 在后），返回 Promise<对应响应 DTO>；统一 same-origin、session 和 CSRF，并将 ApiError 转为可展示错误。列表/详情查询无密钥。

`center-web/App.tsx` 默认导出 App；`center-web/pages/Login.tsx`、`Providers.tsx`、`Models.tsx`、`Devices.tsx`、`Capabilities.tsx`、`Installation.tsx`、`BotCapabilities.tsx` 分别默认导出无必需 props 的路由组件。路由参数使用 React Router：`/login`、`/providers`、`/providers/:providerId/models`、`/devices`、`/capabilities`、`/capabilities/:installationId`、`/devices/:deviceId/bots/:botId/capabilities`。admin-shell 挂载这些 export；plugin-ui 使用同一 api，不创建另一份业务状态。共享配置表单由 `center-web/components/ConfigForm.tsx` 默认导出，props 为 `{schema: JsonSchema, uiSchema?: JsonObject, globalConfig: JsonObject, overrides?: JsonObject, onSave(value: JsonObject): void}`；有 overrides 时 onSave 仅提交覆盖项，否则提交 global。凭证字段只显示引用及配置状态，不回填秘密。

## 依赖与验收边界

各清单是互相独立的 npm 安装根，父助手生成对应 lockfile；原 root 和 host lock 不在此轮改动。RJSF 同版 6.11.0、deepmerge 4.3.1、npm 11.6.2 来自计划；pi-mcp 1.1.0 和 yaml 2.9.0 来自现有 `pi-runtime/package-lock.json`，与现有 Pi 配套需实际验收；React/Vite 使用项目已有版本。Fastify 及插件、Ajv、pacote 和 semver 的清单为固定候选版本，未进行 registry/安装/兼容性验证；父助手在 P0 安装时核验，不能将本契约视作已完成库兼容验证。中心 web、server 分别依赖 center-contract，server 专用依赖不进入 Host/Android/浏览器 bundle。

此轮无业务 stub、无新增测试；端到端需验证真实中心/Host/浏览器及设备，尤其在线中断、CAS、秘密边界、数组替换、制品安全、目标平台 npm 和 React 19 表单。
