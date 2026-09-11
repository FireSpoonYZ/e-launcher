import assert from "node:assert/strict";
import http from "node:http";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createPiRuntime } from "./index.js";
import { resolveConfig } from "./config.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function message(model, text, stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

function memoryStream(model, _context, options) {
  const stream = createAssistantMessageEventStream();
  const partial = { ...message(model, "", "pending"), content: [{ type: "text", text: "" }] };
  queueMicrotask(() => {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    for (const delta of ["hel", "lo"]) {
      partial.content[0].text += delta;
      stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
    }
    stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
    const final = message(model, "hello");
    stream.push({ type: "done", reason: "stop", message: final });
    stream.end(final);
  });
  return stream;
}

function cancellableMemoryStream(model, _context, options) {
  const stream = createAssistantMessageEventStream();
  const partial = { ...message(model, "waiting", "pending"), content: [{ type: "text", text: "waiting" }] };
  queueMicrotask(() => {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "waiting", partial });
  });
  options.signal.addEventListener("abort", () => {
    const aborted = message(model, "waiting", "aborted", "Operation aborted");
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
  }, { once: true });
  return stream;
}

function runtime(streamFn) {
  return createPiRuntime({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only", modelId: "test-model", streamFn });
}

async function checkMemoryAgent() {
  const events = [];
  const pi = runtime(memoryStream);
  pi.subscribe((event) => events.push(event));
  await pi.prompt("hi");
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["hel", "lo"]);
  assert.deepEqual(events.find((event) => event.type === "message").message, { role: "assistant", content: "hello" });
  assert.equal(events.at(-1).status, "completed");

  assert.throws(() => pi.replaceHistory([{ role: "assistant", content: null, tool_calls: [{ id: "x" }] }]), /tool_calls are not supported/);
}

async function checkAbort() {
  const events = [];
  const pi = runtime(cancellableMemoryStream);
  pi.subscribe((event) => {
    events.push(event);
    if (event.type === "text_delta") pi.abort();
  });
  await pi.prompt("cancel me");
  assert.equal(events.find((event) => event.type === "error").aborted, true);
  assert.equal(events.find((event) => event.type === "message").message.content, "waiting");
  assert.equal(events.at(-1).status, "aborted");
}

async function checkInterruptedContent() {
  for (const reason of ["length", "error"]) {
    const events = [];
    const pi = runtime((model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const final = message(model, "already generated", reason,
          reason === "error" ? "connection interrupted" : undefined);
        stream.push(reason === "error" ? { type: "error", reason, error: final }
          : { type: "done", reason, message: final });
        stream.end(final);
      });
      return stream;
    });
    pi.subscribe((event) => events.push(event));
    await pi.prompt("preserve partial reply");
    assert.equal(events.find((event) => event.type === "message").message.content, "already generated");
    assert.equal(events.at(-1).status, reason === "length" ? "truncated" : "error");
  }
}

async function checkOpenAIAdapter() {
  let requestSeen = false;
  let expectedEffort;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer mock-key-not-real");
      assert.equal(payload.model, "mock-model");
      assert.equal(payload.reasoning_effort, expectedEffort);
      assert.equal(Object.hasOwn(payload, "reasoning_effort"), expectedEffort !== undefined);
      assert.equal(Object.hasOwn(payload, "max_tokens"), false, "no app output token cap");
      assert.equal(Object.hasOwn(payload, "max_completion_tokens"), false, "no app completion token cap");
      requestSeen = true;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "adapter ok" }, finish_reason: null }] });
      chunk({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    for (const effort of ["", "low", "medium", "high"]) {
      expectedEffort = effort || undefined;
      requestSeen = false;
      const events = [];
      const pi = createPiRuntime({ config: {
        settings: { defaultProvider: "test", defaultModel: "mock-model", ...(effort ? { defaultThinkingLevel: effort } : {}) },
        models: { providers: { test: { baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "mock-model" }] } } },
        auth: { test: { type: "api_key", key: "mock-key-not-real" } },
      } });
      pi.subscribe((event) => events.push(event));
      await pi.prompt("local mock only");
      assert.equal(requestSeen, true);
      assert.equal(events.find((event) => event.type === "message").message.content, "adapter ok");
      assert.equal(events.at(-1).status, "completed");
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const config = {
  settings: { defaultProvider: "test", defaultModel: "model", defaultThinkingLevel: "low", modelThinkingLevels: { "test/model": "high" } },
  models: { providers: { test: { baseUrl: "https://example.com/v1", models: [{ id: "model" }], headers: { "x-test": "$VALUE" } } } },
  auth: { test: { type: "api_key", key: "$KEY", env: { KEY: "mock", VALUE: "value" } } },
};
assert.equal(resolveConfig(config).reasoningEffort, "high");
assert.equal(resolveConfig(config).apiKey, "mock");
assert.equal(resolveConfig(config).modelConfig.headers["x-test"], "value");
assert.throws(() => resolveConfig({ ...config, auth: { test: { type: "api_key", key: "!command", env: { VALUE: "value" } } } }), /命令引用/);
assert.throws(() => resolveConfig({ ...config, settings: { defaultProvider: "missing" } }), /未配置服务商/);

await checkMemoryAgent();
await checkAbort();
await checkInterruptedContent();
await checkOpenAIAdapter();
console.log("pi-runtime check passed: Agent events, retained abort/error/length output, and local mock OpenAI adapter stream");
