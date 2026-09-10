import { Agent } from "@earendil-works/pi-agent-core";
import { stream as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function makeModel({ baseUrl, modelId }) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "host-openai-compatible",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: EMPTY_COST,
    // Custom endpoint capabilities are unknown; the direct adapter sends no output budget.
    contextWindow: 0,
    maxTokens: 0,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function toAgentHistory(history) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array");
  return history.map((message, index) => {
    if (message?.role !== "user" && message?.role !== "assistant") {
      throw new TypeError(`history[${index}].role must be user or assistant; tools are not connected`);
    }
    if (message.tool_calls?.length) throw new TypeError(`history[${index}].tool_calls are not supported yet`);
    if (typeof message.content !== "string") throw new TypeError(`history[${index}].content must be a string`);
    if (message.role === "user") return { role: "user", content: message.content, timestamp: Date.now() };
    return {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: "openai-completions",
      provider: "host-openai-compatible",
      model: "history",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...EMPTY_COST, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });
}

function messageText(message) {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

/**
 * Creates a text-only pi Agent boundary. Events are transport-neutral objects:
 * text_delta, message, error, and end. No pi user config or extensions are read.
 */
export function createPiRuntime({ baseUrl, apiKey, modelId, systemPrompt = "You are a helpful assistant.", history = [], streamFn } = {}) {
  requireText(baseUrl, "baseUrl");
  requireText(apiKey, "apiKey");
  requireText(modelId, "modelId");
  const model = makeModel({ baseUrl, modelId });
  const listeners = new Set();
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const effectiveStreamFn = streamFn ?? ((requestModel, context, options) =>
    streamOpenAICompletions(requestModel, context, { ...options, apiKey }));
  const agent = new Agent({
    initialState: { systemPrompt, model, tools: [], messages: toAgentHistory(history) },
    streamFn: effectiveStreamFn,
  });

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = messageText(event.message);
      // Error/abort messages can still contain useful output produced before interruption.
      if (text || !event.message.errorMessage) {
        emit({ type: "message", message: { role: "assistant", content: text } });
      }
      if (event.message.errorMessage) {
        emit({ type: "error", message: event.message.errorMessage, aborted: event.message.stopReason === "aborted" });
      }
    } else if (event.type === "agent_end") {
      const last = event.messages.findLast((message) => message.role === "assistant");
      const status = last?.stopReason === "aborted" ? "aborted"
        : last?.stopReason === "length" ? "truncated"
        : last?.errorMessage || last?.stopReason === "error" ? "error" : "completed";
      emit({ type: "end", status });
    }
  });

  return {
    prompt(text) {
      requireText(text, "prompt");
      return agent.prompt(text);
    },
    abort() {
      agent.abort();
    },
    replaceHistory(nextHistory) {
      if (agent.state.isStreaming) throw new Error("cannot replace history while streaming");
      agent.state.messages = toAgentHistory(nextHistory);
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
