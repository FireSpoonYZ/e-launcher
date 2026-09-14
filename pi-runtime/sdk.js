import { mkdir, mkdtemp, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join, resolve, relative, dirname } from "node:path";
import {
  AgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SettingsManager, SessionManager,
  DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import undici from "./node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js";
import { getThemeByName } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { toAgentHistory } from "./index.js";
import {
  ExtensionUiBridge,
  findRpivAskUserQuestionTool,
  findRpivTodoTool,
  readTodoSnapshot,
  replayRpivTodo,
} from "./extension-ui.js";

// Some upstream adapters reject a custom fetch unless it is globalThis.fetch. Keep that identity
// stable while AsyncLocalStorage routes every provider, OAuth and extension fetch to its runtime.
const sessionHttp = new AsyncLocalStorage();
const processFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => (sessionHttp.getStore() ?? processFetch)(input, init);

function quietDispatcher(dispatcher) {
  dispatcher.on("error", () => {});
  return dispatcher;
}

function createOriginClient(origin, options) {
  return quietDispatcher(new undici.Client(origin, options));
}

function createOriginDispatcher(origin, options) {
  if (options.connections === 1) return createOriginClient(origin, options);
  return quietDispatcher(new undici.Pool(origin, { ...options, factory: createOriginClient }));
}

async function services(config, signal, resourceLoaderOptions) {
  if (!config?.agentDir || !config?.cwd || !config?.cacheDir) throw new Error("缺少应用私有运行目录");
  for (const [key, value] of Object.entries(config.runtimeEnvironment ?? {})) {
    if (typeof value !== "string") throw new Error("运行环境配置无效");
    process.env[key] = value;
  }
  const agentDir = resolve(config.agentDir), cwd = resolve(config.cwd), cacheDir = resolve(config.cacheDir);
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const temporary = await mkdtemp(join(cacheDir, "pi-request-"));
  let dispatcher;
  try {
    // Native models.json parsing/composition, with the immutable send-time snapshot.
    const modelsPath = join(temporary, "models.json");
    await writeFile(modelsPath, JSON.stringify(config.models ?? {}), { mode: 0o600 });
    const credentials = new InMemoryCredentialStore();
    for (const [id, credential] of Object.entries(config.auth ?? {})) {
      await credentials.modify(id, () => credential);
    }
    const scoped = { global: JSON.stringify(config.globalSettings ?? config.settings ?? {}),
      project: JSON.stringify(config.projectSettings ?? {}) };
    const settingsManager = SettingsManager.fromStorage({ withLock(scope, update) {
      const next = update(scoped[scope]);
      if (next !== undefined) scoped[scope] = next;
    } }, { projectTrusted: true });
    const timeout = settingsManager.getHttpIdleTimeoutMs();
    const proxy = settingsManager.getGlobalSettings().httpProxy?.trim();
    const agent = quietDispatcher(new undici.EnvHttpProxyAgent({
      ...(proxy ? { httpProxy: proxy, httpsProxy: proxy } : {}),
      allowH2: false, proxyTunnel: true, bodyTimeout: timeout, headersTimeout: timeout,
      connect: { autoSelectFamilyAttemptTimeout: 2_000 },
      clientFactory: createOriginClient, factory: createOriginDispatcher,
    }));
    dispatcher = {
      dispatch: (options, handler) => agent.dispatch({
        ...options, bodyTimeout: timeout, headersTimeout: timeout,
      }, handler),
      close: () => agent.close(),
    };
    const fetch = (input, init) => undici.fetch(input, { ...init, dispatcher: init?.dispatcher ?? dispatcher });
    const native = await sessionHttp.run(fetch, async () => {
      const modelRuntime = await ModelRuntime.create({ credentials, modelsPath,
        modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, signal });
      if (modelRuntime.getError()) throw new Error(modelRuntime.getError());
      return createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime,
        modelRuntimeSignal: signal, resourceLoaderOptions });
    });
    return { ...native, credentials, fetch, withHttp: (task) => sessionHttp.run(fetch, task), dispose: async () => {
      try { await dispatcher.close(); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await dispatcher?.close(); }
    catch { /* Preserve the initialization error. */ }
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function attachmentInput(attachments, config, model) {
  if (!Array.isArray(attachments) || attachments.length === 0) return { images: [], files: [] };
  const root = resolve(config.chatAttachmentRoot ?? "");
  const canonicalRoot = await realpath(root);
  const images = [], files = [];
  for (const item of attachments) {
    if (!item || typeof item.id !== "string" || typeof item.path !== "string" || typeof item.mimeType !== "string") throw new Error("附件信息无效");
    const path = resolve(item.path);
    if (dirname(path) !== root || path !== join(root, item.id)) throw new Error("附件路径无效");
    const canonicalPath = await realpath(path);
    if (dirname(canonicalPath) !== canonicalRoot) throw new Error("附件路径无效");
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 * 1024) throw new Error("附件大小无效");
    if (item.kind === "image") {
      if (!item.mimeType.startsWith("image/")) throw new Error("图片类型无效");
      if (!model.input?.includes("image")) throw new Error("当前模型不支持图片输入");
      images.push({ type: "image", data: (await readFile(canonicalPath)).toString("base64"), mimeType: item.mimeType });
    } else {
      files.push({ name: String(item.name || "附件"), mimeType: item.mimeType, size: info.size, path: canonicalPath });
    }
  }
  return { images, files };
}

async function historyWithAttachments(history, config, model) {
  const converted = toAgentHistory(history ?? []);
  for (let i = 0; i < converted.length; i++) if (history[i]?.role === "user" && history[i].attachments?.length) {
    const input = await attachmentInput(history[i].attachments, config, model);
    const text = input.files.length ? `${history[i].content}\n\n${fileNotice(input.files)}` : history[i].content;
    converted[i].content = [{ type: "text", text }, ...input.images];
  }
  return converted;
}

function fileNotice(files) {
  return `[用户附件已安全复制到应用私有工作区。请使用 read 工具实际读取，不要声称已读取而未读取。]\n${files.map(file => `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${file.path}`).join("\n")}`;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function toolResultAttachments(content, config) {
  const images = content.filter((part) => part.type === "image");
  if (images.length === 0) return [];
  if (typeof config.chatAttachmentRoot !== "string" || !config.chatAttachmentRoot) throw new Error("缺少聊天附件目录");
  const root = resolve(config.chatAttachmentRoot);
  await mkdir(root, { recursive: true });
  const paths = [];
  try {
    const attachments = [];
    for (const image of images) {
      if (typeof image.mimeType !== "string" || !/^image\/[a-z0-9][a-z0-9.+-]*$/i.test(image.mimeType)) {
        throw new Error("工具图片类型无效");
      }
      if (typeof image.data !== "string" || image.data.length === 0
          || image.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new Error("工具图片数据无效");
      const data = Buffer.from(image.data, "base64");
      if (data.length < 1) throw new Error("工具图片数据无效");
      if (data.length > MAX_ATTACHMENT_BYTES) throw new Error("工具图片大小无效");
      if (data.toString("base64") !== image.data) throw new Error("工具图片数据无效");
      const id = randomUUID(), path = join(root, id);
      try { await writeFile(path, data, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (error?.code !== "EEXIST") await rm(path, { force: true });
        throw error;
      }
      paths.push(path);
      attachments.push({ id, name: "工具图片", mimeType: image.mimeType, kind: "image", size: data.length, path });
    }
    return attachments;
  } catch (error) {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
    throw error;
  }
}

async function credentialChanges(s, config, emit) {
  const ids = new Set([...Object.keys(config.auth ?? {}), ...(await s.credentials.list()).map((item) => item.providerId)]);
  for (const providerId of ids) {
    const value = await s.credentials.read(providerId);
    if (JSON.stringify(value) !== JSON.stringify(config.auth?.[providerId])) {
      emit({ type: "credential", providerId, value: value ?? null,
        previous: config.auth?.[providerId] ?? null });
    }
  }
}

export async function createSdkRuntime(command, signal, resourceLoaderOptions) {
  const config = command.config;
  const s = await services(config, signal, resourceLoaderOptions);
  let session, lifecycle, uiBridge, disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    uiBridge?.suspend();
    try {
      if (lifecycle) await s.withHttp(() => lifecycle.dispose());
      else session?.dispose();
    } finally {
      try { uiBridge?.dispose(); }
      finally { await s.dispose(); }
    }
  };
  try {
    const provider = config.selection?.provider ?? s.settingsManager.getDefaultProvider();
    const modelId = config.selection?.model ?? s.settingsManager.getDefaultModel();
    const model = s.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`模型不存在：${provider}/${modelId}`);
    const level = config.selection?.thinkingLevel ?? s.settingsManager.getModelThinkingLevel(provider, modelId)
      ?? s.settingsManager.getDefaultThinkingLevel() ?? "off";
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw new Error("不支持的思考强度");
    if (level !== "off" && !model.reasoning) throw new Error("当前模型未启用推理能力，请在模型配置中设置 reasoning");
    if (model.thinkingLevelMap?.[level] === null) throw new Error("当前模型不支持所选思考档位");
    const history = command.sdkHistory ?? await historyWithAttachments(command.history ?? [], config, model);
    if (!Array.isArray(history)) throw new Error("Pi 会话记录必须是数组");
    const nativeEntries = history[0]?.type === "session";
    const sessionManager = SessionManager.inMemory(s.cwd, undefined, nativeEntries ? history : undefined);
    if (!nativeEntries) for (const message of history) sessionManager.appendMessage(message);
    for (const message of await historyWithAttachments(command.sdkHistoryTail ?? [], config, model)) sessionManager.appendMessage(message);
    const result = await s.withHttp(() => createAgentSessionFromServices({
      services: s, model, thinkingLevel: level, sessionManager,
    }));
    session = result.session;
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (requestModel, context, options) =>
      stream(requestModel, context, { ...options, fetch: globalThis.fetch });
    if (session.thinkingLevel !== level) throw new Error(`模型实际支持的思考强度为 ${session.thinkingLevel}，请重新选择`);
    lifecycle = new AgentSessionRuntime(session, s, async () => { throw new Error("不支持在单轮中替换会话"); }, s.diagnostics);
    const listeners = new Set();
    const emit = (event) => { for (const listener of listeners) listener(event); };
    const todoTool = await findRpivTodoTool(session.getAllTools());
    const askUserTool = await findRpivAskUserQuestionTool(session.getAllTools());
    let todo = replayRpivTodo(session.sessionManager.getBranch(), todoTool);
    let genericUi, uiReady = false;
    const extensionUi = () => ({ ...genericUi, todo });
    const emitExtensionUi = () => emit({ type:"extension_ui", state:structuredClone(extensionUi()) });
    const configuredTheme = s.settingsManager.getTheme();
    uiBridge = new ExtensionUiBridge({
      theme:getThemeByName(configuredTheme) ?? getThemeByName("dark") ?? {},
      ignoredWidgetKeys:todoTool ? new Set(["rpiv-todos"]) : new Set(),
    });
    uiBridge.subscribe((snapshot) => {
      genericUi = snapshot;
      if (uiReady) emitExtensionUi();
    });
    if (askUserTool) {
      const definition = session.getToolDefinition(askUserTool.name);
      const execute = definition?.execute;
      if (typeof execute === "function") {
        definition.execute = (...args) => uiBridge.runAskUserQuestion(
          args[1], args[2], () => execute.apply(definition, args));
      }
    }
    await s.withHttp(() => session.bindExtensions({ uiContext:uiBridge.ui }));
    uiReady = true;
    let eventQueue = Promise.resolve(), eventError;
    session.subscribe((event) => {
      eventQueue = eventQueue.then(async () => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          emit({ type: "message", message: { role: "assistant", stopReason: event.message.stopReason,
            errorMessage: event.message.errorMessage,
            content: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
            toolCalls: event.message.content.filter((part) => part.type === "toolCall")
              .map((part) => ({ id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) })) } });
        } else if (event.type === "message_end" && event.message.role === "toolResult") {
          if (todoTool && event.message.toolName === todoTool.name) {
            const snapshot = readTodoSnapshot(event.message.details);
            if (snapshot) {
              todo = snapshot;
              emitExtensionUi();
            }
          }
          emit({ type: "message", message: { role: "tool",
            content: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
            toolCallId: event.message.toolCallId,
            attachments: await toolResultAttachments(event.message.content, config) } });
        } else if (event.type === "tool_execution_start") {
          emit({ type: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
        } else if (event.type === "tool_execution_end") {
          emit({ type: "tool_end", toolCallId: event.toolCallId, name: event.toolName,
            result: event.result, isError: event.isError });
        } else if (event.type === "auto_retry_start" || event.type === "auto_compaction_start") {
          emit({ type: "status", message: event.type === "auto_retry_start" ? "Pi 正在重试" : "Pi 正在压缩上下文" });
        }
      }).catch((error) => { eventError ??= error; });
    });
    return {
      subscribe(listener) {
        listeners.add(listener);
        listener({ type:"extension_ui", state:structuredClone(extensionUi()) });
        return () => listeners.delete(listener);
      },
      replyAskUserQuestion(id, result) { return uiBridge.replyAskUserQuestion(id, result); },
      cancelAskUserQuestion(id) { return uiBridge.cancelAskUserQuestion(id); },
      abort() { return session.abort(); },
      async prompt(text, attachments = command.attachments) {
        const onAbort = () => { void session.abort(); };
        signal?.addEventListener("abort", onAbort, { once: true });
        let status;
        try {
          const input = await attachmentInput(attachments, config, model);
          const prompt = input.files.length ? `${text || ""}\n\n${fileNotice(input.files)}` : text || "请查看附件。";
          signal?.throwIfAborted();
          await s.withHttp(() => session.prompt(prompt, { images: input.images }));
          await eventQueue;
          if (eventError) throw eventError;
          const last = session.messages.findLast((message) => message.role === "assistant");
          if (last?.errorMessage) emit({ type: "error", message: last.errorMessage, aborted: last.stopReason === "aborted" });
          status = signal?.aborted || last?.stopReason === "aborted" ? "aborted"
            : last?.stopReason === "length" ? "truncated" : last?.errorMessage ? "error" : "completed";
        } finally {
          signal?.removeEventListener("abort", onAbort);
          await eventQueue;
          try {
            emit({ type: "context", messages: session.messages,
              entries: [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()] });
            await credentialChanges(s, config, emit);
          } finally {
            await dispose();
          }
        }
        emit({ type: "end", status });
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Settings reads use the same native registry as chat, not a separate model catalog. */
export async function sdkQuery(command, signal, emit = () => {}, interact = async () => { throw new Error("登录需要用户输入"); }, resourceLoaderOptions) {
  const s = await services(command.config, signal, resourceLoaderOptions);
  try {
    return await s.withHttp(async () => {
    if (["packages", "install", "remove", "update", "resource_paths", "resource_toggle"].includes(command.type)) {
      const manager = new DefaultPackageManager(s);
      manager.setProgressCallback((event) => emit({ type: "status", message: event.message ?? `${event.action}: ${event.source}` }));
      if (command.type === "packages") return manager.listConfiguredPackages();
      if (command.type === "resource_paths") return manager.resolve(async () => "skip");
      if (command.type === "resource_toggle") {
        const kind = command.kind;
        if (!["extensions", "skills", "prompts", "themes"].includes(kind)) throw new Error("未知资源类型");
        const paths = await manager.resolve(async () => "skip");
        const item = paths[kind].find((entry) => entry.path === command.path);
        if (!item || item.metadata.scope === "temporary") throw new Error("资源已变化，请重新读取");
        const project = item.metadata.scope === "project";
        const settings = project ? s.settingsManager.getProjectSettings() : s.settingsManager.getGlobalSettings();
        const packaged = item.metadata.origin === "package";
        const key = packaged ? "packages" : kind;
        const previous = settings[key];
        const next = structuredClone(previous ?? []);
        let target = settings;
        if (packaged) {
          const index = next.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === item.metadata.source);
          if (index < 0) throw new Error("资源所属的包已变化");
          if (typeof next[index] === "string") next[index] = { source: next[index] };
          target = next[index];
        }
        const base = item.metadata.baseDir ?? (packaged ? dirname(item.path) : project ? join(s.cwd, ".pi") : s.agentDir);
        const pattern = relative(base, item.path).replaceAll("\\", "/");
        const patterns = (target[kind] ?? []).filter((entry) => {
          if (!packaged && !/^[!+-]/.test(entry)) return true;
          return entry.replace(/^[!+-]/, "").replaceAll("\\", "/") !== pattern;
        });
        if (command.enabled !== null) patterns.push(`${command.enabled ? "+" : "-"}${pattern}`);
        if (packaged) {
          if (patterns.length) target[kind] = patterns;
          else delete target[kind];
        }
        emit({ type: "setting", project, key, previous: previous ?? null, value: packaged ? next : patterns });
        return { enabled: command.enabled };
      }
      if (typeof command.source !== "string" || !command.source.trim()) throw new Error("请输入包来源");
      const local = Boolean(command.project);
      const before = (local ? s.settingsManager.getProjectSettings() : s.settingsManager.getGlobalSettings()).packages;
      if (command.type === "install") await manager.installAndPersist(command.source, { local });
      if (command.type === "remove") {
        if (!await manager.removeAndPersist(command.source, { local })) throw new Error("当前范围内没有这个包");
      }
      if (command.type === "update") await manager.update(command.source);
      await s.settingsManager.flush();
      const after = (local ? s.settingsManager.getProjectSettings() : s.settingsManager.getGlobalSettings()).packages;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        emit({ type: "setting", project: local, key: "packages", previous: before ?? null, value: after ?? [] });
      }
      return { source: command.source };
    }
    if (command.type === "login") {
      await s.modelRuntime.login(command.providerId, command.authType ?? "oauth", {
        signal, prompt: interact, notify: (event) => emit({ type: "auth", event }),
      });
      return { providerId: command.providerId };
    }
    if (command.type === "logout") {
      await s.modelRuntime.logout(command.providerId, { signal });
      return { providerId: command.providerId };
    }
    if (command.type === "catalog") {
      if (command.refresh) await s.modelRuntime.refresh({ allowNetwork: true, force: true, signal });
      return s.modelRuntime.getProviders().map((provider) => ({ id: provider.id, name: provider.name,
        authMethods: [provider.auth?.apiKey?.login ? "api_key" : null, provider.auth?.oauth ? "oauth" : null].filter(Boolean),
        auth: s.modelRuntime.getProviderAuthStatus(provider.id),
        models: s.modelRuntime.getModels(provider.id).map((model) => ({ id: model.id, name: model.name,
          reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap,
          thinkingLevels: getSupportedThinkingLevels(model), api: model.api })) }));
    }
    if (command.type === "resources") {
      const loader = s.resourceLoader;
      const extensions = loader.getExtensions();
      const loadedPaths = new Set(extensions.extensions.map((extension) => resolve(extension.path)));
      const manager = new DefaultPackageManager(s);
      const resolved = await manager.resolve(async () => "skip");
      const packages = await Promise.all(manager.listConfiguredPackages().map(async (item) => {
        if (!item.installedPath || !item.source.startsWith("npm:")) return item;
        try {
          const manifest = JSON.parse(await readFile(join(item.installedPath, "package.json"), "utf8"));
          return { ...item, version: manifest.version };
        } catch (error) {
          return { ...item, manifestError: error.message };
        }
      }));
      const packageExtensions = resolved.extensions.filter((item) => item.metadata?.origin === "package")
        .map((item) => ({ path: item.path, source: item.metadata.source, scope: item.metadata.scope,
          enabled: item.enabled, loaded: loadedPaths.has(resolve(item.path)),
          errors: extensions.errors.filter((error) => error.path && resolve(error.path) === resolve(item.path)) }));
      return { skills: loader.getSkills(), prompts: loader.getPrompts(), themes: loader.getThemes(),
        extensions: extensions.extensions.map((extension) => ({ path: extension.path,
          tools: extension.tools?.size ?? 0, commands: extension.commands?.size ?? 0,
          flags: extension.flags?.size ?? 0, shortcuts: extension.shortcuts?.size ?? 0 })),
        packages, packageExtensions, errors: [...extensions.errors, ...s.diagnostics] };
    }
    if (command.type === "test_provider") {
      const model = s.modelRuntime.getModels(command.providerId)[0];
      if (!model) throw new Error("该服务商没有模型");
      const message = await s.modelRuntime.completeSimple(model, {
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      }, { signal, fetch: globalThis.fetch });
      if (message.errorMessage) throw new Error(message.errorMessage);
      return { model: model.id };
    }
    throw new Error("未知的 Pi 配置操作");
    });
  } finally {
    try { await credentialChanges(s, command.config, emit); }
    finally { await s.dispose(); }
  }
}
