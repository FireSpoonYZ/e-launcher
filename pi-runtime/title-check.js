import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import conversationTitle from "./extensions/conversation-title/index.js";

const home = await mkdtemp(join(tmpdir(), "launcher-title-check-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
const requests = [];
let title = "“整理桌面应用”", failTitle = false, cancelTitle;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push({ payload, authorization: request.headers.authorization });
  if (payload.model === "title-model" && cancelTitle) {
    cancelTitle();
    response.destroy();
    return;
  }
  if (payload.model === "title-model" && failTitle) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "synthetic title failure" } }));
    return;
  }
  const content = payload.model === "title-model" ? title : "聊天回复";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: "mock",
    object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { createSdkRuntime } = await import("./sdk.js");
  const provider = (id) => ({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    api: "openai-completions", models: [{ id, reasoning: false, input: ["text"] }] });
  const config = { agentDir: join(home, "agent"), cwd: join(home, "workspace"), cacheDir: join(home, "cache"),
    settings: { defaultProvider: "chat", defaultModel: "chat-model", defaultTools: [],
      compaction: { enabled: false }, retry: { enabled: false }, conversationTitle: { model: "titles/title-model" } },
    models: { providers: { chat: provider("chat-model"), titles: provider("title-model") } },
    auth: { chat: { type: "api_key", key: "chat-key" }, titles: { type: "api_key", key: "title-key" } } };
  let history;
  async function run(prompt, signal) {
    const runtime = await createSdkRuntime({ config, sdkHistory: history }, signal, {
      extensionFactories: [{ name: "conversation-title", factory: (pi) =>
        conversationTitle(pi, config.settings.conversationTitle, signal) }],
    });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.prompt(prompt);
    history = events.find((event) => event.type === "context").entries;
    assert.equal(events.filter((event) => event.type === "message").length, 1, "title is not a chat message");
    return events;
  }
  const sessionTitle = () => history.findLast((entry) => entry.type === "session_info")?.name;
  assert.equal((await run("整理桌面应用")).at(-1).status, "completed");
  assert.equal(sessionTitle(), "整理桌面应用");
  assert.deepEqual(requests.map(({ payload }) => payload.model), ["chat-model", "title-model"]);
  assert.equal(requests[1].authorization, "Bearer title-key", "title model uses its own provider credentials");
  assert.equal(requests[1].payload.tools?.length ?? 0, 0, "title request cannot call tools");

  title = "标题：优化桌面分组";
  await run("接下来按用途分组");
  assert.equal(sessionTitle(), "优化桌面分组", "resumed sessions get a fresh title each turn");
  assert(JSON.stringify(requests.at(-1).payload.messages).includes("整理桌面应用"));
  assert.equal(history.filter((entry) => entry.type === "session_info").length, 2);

  failTitle = true;
  assert.equal((await run("继续整理")).at(-1).status, "completed", "title failures do not fail the chat");
  assert.equal(sessionTitle(), "优化桌面分组");
  failTitle = false;
  title = "  ";
  await run("继续");
  assert.equal(sessionTitle(), "优化桌面分组", "empty results preserve the title");

  for (const model of ["", "missing/model"]) {
    config.settings.conversationTitle.model = model;
    const before = requests.length;
    await run("未配置标题模型");
    assert.equal(requests.length, before + 1, "never falls back to the chat model");
    assert.equal(sessionTitle(), "优化桌面分组");
  }
  config.settings.conversationTitle.model = "titles/title-model";
  const controller = new AbortController();
  cancelTitle = () => controller.abort();
  assert.equal((await run("取消标题生成", controller.signal)).at(-1).status, "aborted");
  assert.equal(sessionTitle(), "优化桌面分组");
  console.log("PASS: title extension SDK lifecycle, separate model/auth, resume, failure, empty output, disabled/missing model and cancellation");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
