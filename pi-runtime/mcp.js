import { readFileSync, existsSync, writeFileSync, renameSync, rmSync, realpathSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { loadMcpConfig, addMcpServerConfig, updateMcpServerConfig, removeMcpServerConfig } from "./node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { validateMcpServerConfig, mcpNamespace } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import { FileAuthStorageBackend } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { McpOAuthCredentialStore, McpServerConnection, createDefaultTransport, signInMcpServer } from "./node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/runtime.js";

function revision(path) {
  return createHash("sha256").update(existsSync(path) ? readFileSync(path) : "{}").digest("hex");
}

function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return existsSync(parent) ? resolve(realpathSync(parent), path.slice(parent.length + 1)) : resolve(path);
}

function atomicWrite(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".new";
  const fd = openSync(temporary, "w", 0o600);
  try {
    try { writeFileSync(fd, source, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** The same private directories and transport adapter are used by chat and settings probes. */
export function mcpOptions(config, signal, openUrl) {
  const transports = new Set();
  let disposed = false;
  const credentials = new McpOAuthCredentialStore(
    new FileAuthStorageBackend(join(config.agentDir, "mcp-auth.json")), config.agentDir);
  return {
    credentials, logPath: join(config.agentDir, "mcp.log"), openUrl,
    async dispose() {
      disposed = true;
      await Promise.allSettled([...transports].map(transport => transport.close()));
    },
    loadConfig() {
      const loaded = loadMcpConfig({ agentDir: config.agentDir, cwd: config.cwd, projectTrusted: false });
      return { ...loaded, errors: loaded.errors.map(error => /JSON|Unexpected token|Unexpected end/i.test(error)
        ? "MCP 配置文件 JSON 无效；请在配置编辑器中修复" : error) };
    },
    createTransport(entry, cwd, auth) {
      signal?.throwIfAborted();
      if (disposed) throw new Error("MCP runtime 已关闭");
      let adapted = entry;
      // Android ships a real node symlink and npm JS, not executable npm/npx shell scripts.
      const npm = config.settings?.npmCommand ?? config.globalSettings?.npmCommand;
      if (config.runtimeEnvironment && Array.isArray(npm) && npm.length === 2
          && ["npm", "npx"].includes(entry.config.command)) {
        const script = entry.config.command === "npx" ? npm[1].replace(/npm-cli\.js$/, "npx-cli.js") : npm[1];
        adapted = { ...entry, config: { ...entry.config, command: npm[0], args: [script, ...(entry.config.args ?? [])] } };
      }
      const secrets = new Set();
      const trackedAuth = auth && { ...auth, token: async (...args) => {
        const token = await auth.token(...args); if (token) secrets.add(token); return token;
      } };
      let transport;
      try { transport = createDefaultTransport(adapted, cwd, trackedAuth); }
      catch { throw new Error("url" in entry.config ? "MCP HTTP 配置解析失败（诊断正文已省略）" : "MCP stdio 命令/环境配置解析失败"); }
      for (const value of Object.values(transport.options?.env ?? transport.options?.headers ?? {})) {
        secrets.add(value); if (/^Bearer /i.test(value)) secrets.add(value.slice(7));
      }
      const sanitize = error => {
        error.message = safeError(error.message, entry, secrets);
        if ("body" in error) error.body = undefined;
        return error;
      };
      for (const method of ["start", "send"]) {
        const original = transport[method].bind(transport);
        transport[method] = async (...args) => { try { return await original(...args); } catch (error) { throw sanitize(error); } };
      }
      const onError = transport.onError.bind(transport);
      transport.onError = listener => onError(error => listener(sanitize(error)));
      const onMessage = transport.onMessage.bind(transport);
      transport.onMessage = listener => onMessage(message => {
        if (message.error) message = { ...message, error: { code: message.error.code,
          message: safeError(message.error.message, entry, secrets) } };
        if (message.result?.isError) message = { ...message, result: { ...message.result,
          content: [{ type: "text", text: safeError("MCP tool error", entry, secrets) }], structuredContent: undefined } };
        if (message.method === "notifications/message") message = { ...message, params: { ...message.params,
          data: safeError(String(message.params?.data ?? ""), entry, secrets) } };
        listener(message);
      });
      transports.add(transport);
      const close = transport.close.bind(transport);
      let closing;
      const abort = () => { void transport.close(); };
      transport.close = () => closing ??= (async () => {
        signal?.removeEventListener("abort", abort);
        try { await close(); } finally { transports.delete(transport); }
      })();
      signal?.addEventListener("abort", abort, { once: true });
      return transport;
    },
  };
}

function safeError(message, entry, resolvedSecrets = []) {
  if (!message) return "";
  // HTTP server bodies and OAuth failures can echo credentials we must not resolve twice.
  if ("url" in entry.config) {
    const status = /\bstatus (\d{3})\b/i.exec(String(message))?.[1];
    return status ? `MCP HTTP 请求失败（status ${status}）` : "MCP HTTP/OAuth 请求失败（服务器诊断正文已省略）";
  }
  let text = String(message).split("\n")[0];
  const config = entry.config;
  const secrets = [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {}),
    config.oauth?.clientSecret, config.url, ...resolvedSecrets].filter(value => typeof value === "string" && value);
  for (const value of secrets) {
    text = text.replaceAll(value, "[redacted]");
    if (/^Bearer /i.test(value)) text = text.replaceAll(value.slice(7), "[redacted]");
    for (const match of value.matchAll(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const key = match[1] ?? match[2];
      if (process.env[key]) text = text.replaceAll(process.env[key], "[redacted]");
    }
  }
  return text;
}

export async function mcpQuery(command, config, signal, emit, interact, providerToken) {
  try { return await runMcpQuery(command, config, signal, emit, interact, providerToken); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("MCP 配置或凭据文件 JSON 无效（解析正文已省略）");
    throw error;
  }
}

async function runMcpQuery(command, config, signal, emit, interact, providerToken) {
  const options = mcpOptions(config, signal);
  const loaded = options.loadConfig();
  const paths = { global: join(config.agentDir, "mcp.json") };
  const revisions = Object.fromEntries(Object.entries(paths).map(([scope, path]) => [scope, revision(path)]));
  if (command.type === "mcp_list") return {
    servers: loaded.servers.map(entry => ({
      name: entry.name, scope: entry.scope, source: entry.source, enabled: entry.config.enabled !== false,
      exposure: entry.config.exposure ?? "codemode", transport: "url" in entry.config ? "http" : "stdio",
      state: entry.config.enabled === false ? "disabled" : "unchecked",
    })), errors: loaded.errors, revisions,
  };
  const scope = command.scope;
  if (scope !== "global") throw new Error("MCP 仅支持全局配置；旧工作区配置保留但不再生效");
  if (typeof command.name !== "string") throw new Error("缺少 MCP server name");
  const path = canonicalPath(paths[scope]);
  if (command.type === "mcp_file_save") {
    const target = canonicalPath(resolve(dirname(paths[scope]), command.name));
    if (target !== path) throw new Error("MCP 文件必须是当前作用域的 mcp.json");
    if (typeof command.source !== "string" || typeof command.expected !== "string") throw new Error("缺少 MCP 文件原文与预期版本");
    if (command.source.length > 1_048_576) throw new Error("配置文件过大");
    try { JSON.parse(command.source); } catch { throw new Error("MCP 配置文件 JSON 无效"); }
    const existed = existsSync(path);
    await new FileAuthStorageBackend(path).withLockAsync(async current => {
      if (existsSync(path + ".bak")) { renameSync(path + ".bak", path); current = readFileSync(path, "utf8"); }
      const previous = !existed && current === "{}" ? "{}\n" : current;
      if (previous !== command.expected) throw new Error("MCP 配置已变化，请刷新后合并；草稿已保留");
      if (command.source !== previous) {
        atomicWrite(path + ".previous", previous);
        atomicWrite(path, command.source);
      }
      return { result: undefined };
    });
    return { source: command.source };
  }
  const entry = loaded.servers.find(item => item.name === command.name && item.scope === scope);
  if (command.type === "mcp_edit") {
    if (!entry) throw new Error("服务器已变化，请刷新");
    return { config: JSON.parse(readFileSync(path, "utf8")).mcpServers[entry.name], revision: revisions[scope] };
  }
  if (["mcp_save", "mcp_toggle", "mcp_remove"].includes(command.type)) {
    if (typeof command.revision !== "string" || command.revision !== revisions[scope]) throw new Error("MCP 配置已变化，请刷新后重试");
    let value;
    if (command.type === "mcp_save") {
      value = validateMcpServerConfig(command.name, command.definition);
      if (typeof value === "string") throw new Error(value);
      if (command.name === "__proto__") throw new Error("上游 MCP 文件编辑不支持 __proto__ 名称");
      if (value.timeout !== undefined && !Number.isFinite(value.timeout)) throw new Error("timeout 必须是有限的正数");
      if ("command" in value && (!value.command.trim() || value.command.includes("\0"))) throw new Error("command 必须是一个可执行文件");
      if ("url" in value && (new URL(value.url).username || new URL(value.url).password)) throw new Error("URL 不可包含凭据，请使用 headers 或 OAuth");
      if (loaded.servers.some(item => item.name !== command.name && mcpNamespace(item.name) === mcpNamespace(command.name))) throw new Error("服务器名称冲突");
    } else {
      if (!entry) throw new Error("服务器已变化，请刷新");
      if (command.type === "mcp_toggle" && typeof command.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
    }
    // Use the official file lock and editing helpers, checking the whole file revision inside the lock.
    await new FileAuthStorageBackend(path).withLockAsync(async () => {
      if (revision(path) !== command.revision) throw new Error("MCP 配置已变化，请刷新后重试");
      if (command.type === "mcp_save") addMcpServerConfig(path, command.name, value);
      if (command.type === "mcp_toggle") updateMcpServerConfig(path, command.name, { enabled: command.enabled });
      if (command.type === "mcp_remove") removeMcpServerConfig(path, command.name);
      return { result: undefined };
    });
    return { saved: true };
  }
  if (!entry) throw new Error("服务器已变化，请刷新");
  const connection = new McpServerConnection({ ...options, entry, cwd: config.cwd, onTools: () => {}, providerToken });
  try {
    if (command.type === "mcp_logout") {
      if (!connection.oauthUrl) throw new Error("此服务器不使用 MCP OAuth");
      options.credentials.remove(entry.name, connection.oauthUrl);
      await connection.signOut();
      return { signedOut: true };
    }
    if (entry.config.enabled === false) {
      if (command.type === "mcp_login") throw new Error("请先启用服务器再登录");
      return { name: entry.name, state: "disabled", tools: [] };
    }
    signal?.throwIfAborted();
    await connection.getClient().catch(() => {});
    signal?.throwIfAborted();
    if (command.type === "mcp_login") {
      if (!connection.oauthUrl) throw new Error("此服务器不使用 MCP OAuth");
      await signInMcpServer({
        serverUrl: connection.oauthUrl, store: options.credentials.forServer(entry.name, connection.oauthUrl),
        settings: connection.oauthSettings(), challenge: connection.challenge,
        prompt: {
          showAuthorizationUrl: url => emit({ type: "auth", event: { type: "auth_url", url: String(url), instructions: "打开浏览器授权；可粘贴浏览器重定向 URL。" } }),
          promptForRedirectUrl: upstreamSignal => interact({ type: "text", message: "粘贴授权后的 redirect URL（取消将停止登录）",
            signal: signal ? AbortSignal.any([signal, upstreamSignal]) : upstreamSignal }),
        },
      });
      signal?.throwIfAborted();
      await connection.reconnect().catch(() => {});
    } else if (command.type !== "mcp_check") throw new Error("未知 MCP 操作");
    return { name: entry.name, state: connection.state, checkedAt: Date.now(),
      tools: connection.tools.map(tool => ({ name: tool.name, description: tool.description })),
      error: safeError(connection.error, entry) || (connection.state === "needs-auth" ? "需要 OAuth 登录" : undefined) };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(safeError(error.message, entry));
  } finally {
    try { await connection.close(); } finally { await options.dispose(); }
  }
}
