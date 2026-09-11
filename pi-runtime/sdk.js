import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import {
  createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SettingsManager, SessionManager, DefaultPackageManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { toAgentHistory } from "./index.js";
// The pinned SDK exposes its CLI HTTP bootstrap internally, but not from its public index.
import { applyHttpProxySettings, configureHttpDispatcher } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js";

async function services(config, signal) {
  if (!config?.agentDir || !config?.cwd || !config?.cacheDir) throw new Error("缺少应用私有运行目录");
  const agentDir = resolve(config.agentDir), cwd = resolve(config.cwd), cacheDir = resolve(config.cacheDir);
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const temporary = await mkdtemp(join(cacheDir, "pi-request-"));
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
    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath,
      modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, signal });
    if (modelRuntime.getError()) throw new Error(modelRuntime.getError());
    const native = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, modelRuntimeSignal: signal });
    return { ...native, credentials, dispose: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
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

export async function createSdkRuntime(command, signal) {
  const config = command.config;
  const s = await services(config, signal);
  let session;
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
    const history = command.sdkHistory ?? toAgentHistory(command.history ?? []);
    if (!Array.isArray(history)) throw new Error("Pi 会话记录必须是数组");
    const nativeEntries = history[0]?.type === "session";
    const sessionManager = SessionManager.inMemory(s.cwd, undefined, nativeEntries ? history : undefined);
    if (!nativeEntries) for (const message of history) sessionManager.appendMessage(message);
    for (const message of toAgentHistory(command.sdkHistoryTail ?? [])) sessionManager.appendMessage(message);
    const result = await createAgentSessionFromServices({ services: s, model, thinkingLevel: level, sessionManager });
    session = result.session;
    if (session.thinkingLevel !== level) throw new Error(`模型实际支持的思考强度为 ${session.thinkingLevel}，请重新选择`);
    const listeners = new Set();
    const emit = (event) => { for (const listener of listeners) listener(event); };
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
      } else if (event.type === "tool_execution_start") {
        emit({ type: "tool_start", name: event.toolName });
      } else if (event.type === "tool_execution_end") {
        emit({ type: "tool_end", name: event.toolName, isError: event.isError });
      } else if (event.type === "auto_retry_start" || event.type === "auto_compaction_start") {
        emit({ type: "status", message: event.type === "auto_retry_start" ? "Pi 正在重试" : "Pi 正在压缩上下文" });
      }
    });
    return {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      abort() { return session.abort(); },
      async prompt(text) {
        const onAbort = () => { void session.abort(); };
        signal?.addEventListener("abort", onAbort, { once: true });
        let status;
        try {
          signal?.throwIfAborted();
          await session.prompt(text);
          const last = session.messages.findLast((message) => message.role === "assistant");
          const content = last?.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
          if (last) emit({ type: "message", message: { role: "assistant", content } });
          if (last?.errorMessage) emit({ type: "error", message: last.errorMessage, aborted: last.stopReason === "aborted" });
          status = signal?.aborted || last?.stopReason === "aborted" ? "aborted"
            : last?.stopReason === "length" ? "truncated" : last?.errorMessage ? "error" : "completed";
        } finally {
          signal?.removeEventListener("abort", onAbort);
          emit({ type: "context", messages: session.messages,
            entries: [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()] });
          await credentialChanges(s, config, emit);
          session.dispose();
          await s.dispose();
        }
        emit({ type: "end", status });
      },
    };
  } catch (error) {
    session?.dispose();
    await s.dispose();
    throw error;
  }
}

/** Settings reads use the same native registry as chat, not a separate model catalog. */
export async function sdkQuery(command, signal, emit = () => {}, interact = async () => { throw new Error("登录需要用户输入"); }) {
  const s = await services(command.config, signal);
  try {
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
      return { skills: loader.getSkills(), prompts: loader.getPrompts(), themes: loader.getThemes(),
        extensions: extensions.extensions.map((extension) => ({ path: extension.path,
          tools: extension.tools?.size ?? 0, commands: extension.commands?.size ?? 0,
          flags: extension.flags?.size ?? 0, shortcuts: extension.shortcuts?.size ?? 0 })),
        errors: [...extensions.errors, ...s.diagnostics] };
    }
    if (command.type === "test_provider") {
      const model = s.modelRuntime.getModels(command.providerId)[0];
      if (!model) throw new Error("该服务商没有模型");
      const message = await s.modelRuntime.completeSimple(model, {
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      }, { signal });
      if (message.errorMessage) throw new Error(message.errorMessage);
      return { model: model.id };
    }
    throw new Error("未知的 Pi 配置操作");
  } finally {
    await credentialChanges(s, command.config, emit);
    await s.dispose();
  }
}
