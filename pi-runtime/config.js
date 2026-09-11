const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Resolve the app-private snapshot once per prompt, never the host's personal Pi files. */
export function resolveConfig(config) {
  const { settings = {}, models = {}, auth = {} } = config;
  const providerId = settings.defaultProvider;
  const provider = models.providers?.[providerId];
  if (!provider) throw new Error(`未配置服务商：${providerId ?? "未选择"}`);
  const modelId = settings.defaultModel;
  if (typeof modelId !== "string" || !modelId) throw new Error("请配置默认模型");
  const selected = provider.models?.find((model) => model.id === modelId);
  if (!selected) throw new Error(`服务商 ${providerId} 没有模型 ${modelId}`);
  const model = { ...provider.modelOverrides?.[modelId], ...selected };
  const api = model.api ?? provider.api ?? "openai-completions";
  if (api !== "openai-completions") throw new Error(`当前 Android 文本运行时尚未接入 ${api}；配置已保留`);
  const credential = auth[providerId];
  if (credential && credential.type !== "api_key") throw new Error("当前 Android 文本运行时尚未接入 OAuth 登录");
  const env = credential?.env ?? {};
  const resolveValue = (value) => {
    if (typeof value !== "string") return value;
    if (value.startsWith("!")) throw new Error("当前运行时不执行凭据中的命令引用");
    if (value.startsWith("$$") || value.startsWith("$!")) return value.slice(1);
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, wrapped, bare) => {
      const name = wrapped ?? bare;
      if (env[name] === undefined) throw new Error(`尚未配置服务商环境变量：${name}`);
      return env[name];
    });
  };
  const headers = Object.fromEntries(Object.entries({ ...provider.headers, ...model.headers })
    .map(([name, value]) => [name, resolveValue(value)]));
  const reasoningEffort = settings.modelThinkingLevels?.[`${providerId}/${modelId}`]
    ?? settings.defaultThinkingLevel ?? "";
  if (reasoningEffort !== "" && !LEVELS.has(reasoningEffort)) throw new Error("不支持的思考强度");
  if (reasoningEffort && reasoningEffort !== "off" && model.reasoning === false) {
    throw new Error("该模型已配置为不支持推理，请调整模型能力或思考强度");
  }
  if (model.thinkingLevelMap?.[reasoningEffort] === null) throw new Error("模型不支持所选思考档位");
  return {
    baseUrl: provider.baseUrl,
    apiKey: resolveValue(credential?.key ?? provider.apiKey),
    modelId,
    reasoningEffort,
    modelConfig: { ...model, provider: providerId, api, headers,
      compat: { ...provider.compat, ...model.compat } },
    thinkingBudgets: settings.thinkingBudgets,
    systemPrompt: (config.systemPrompt || "You are a helpful assistant.")
      + (config.appendSystemPrompt ? `\n\n${config.appendSystemPrompt}` : ""),
  };
}
