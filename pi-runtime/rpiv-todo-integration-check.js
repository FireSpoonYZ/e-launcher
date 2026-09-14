import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSdkRuntime } from "./sdk.js";

const agentDir = process.env.RPIV_TODO_AGENT_DIR || join(homedir(), ".pi", "agent");
try {
  await access(join(agentDir, "npm", "node_modules", "@juicesharp", "rpiv-todo", "package.json"));
} catch {
  console.log(`SKIP: unmodified @juicesharp/rpiv-todo is not installed under ${agentDir}`);
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "launcher-rpiv-todo-"));
let requestCount = 0;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* drain */ }
  const first = requestCount++ === 0;
  const delta = first
    ? { role:"assistant", tool_calls:[{ index:0, id:"todo-create", type:"function",
      function:{ name:"todo", arguments:JSON.stringify({ action:"create", subject:"created by the original package" }) } }] }
    : { role:"assistant", content:"done" };
  response.writeHead(200, { "Content-Type":"text/event-stream" });
  response.end(`data: ${JSON.stringify({ id:"mock", object:"chat.completion.chunk", choices:[{ index:0, delta, finish_reason:null }] })}\n\ndata: ${JSON.stringify({ id:"mock", object:"chat.completion.chunk", choices:[{ index:0, delta:{}, finish_reason:first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const cwd = join(root, "workspace"), cacheDir = join(root, "cache");
  const saved = SessionManager.inMemory(cwd);
  saved.appendMessage({ role:"toolResult", toolCallId:"prior", toolName:"todo",
    content:[{ type:"text", text:"prior" }], details:{ tasks:[{ id:1, subject:"restored from details", status:"in_progress" }], nextId:2 },
    isError:false, timestamp:Date.now() });
  saved.appendMessage({ role:"toolResult", toolCallId:"corrupt", toolName:"todo",
    content:[{ type:"text", text:"corrupt" }], details:{ tasks:"not-a-snapshot", nextId:99 },
    isError:false, timestamp:Date.now() });
  const config = {
    agentDir, cwd, cacheDir,
    settings:{ packages:["npm:@juicesharp/rpiv-todo"], defaultProvider:"local", defaultModel:"mock",
      defaultTools:["todo"], compaction:{ enabled:false } },
    models:{ providers:{ local:{ baseUrl:`http://127.0.0.1:${server.address().port}/v1`, api:"openai-completions",
      models:[{ id:"mock", name:"Mock", reasoning:false, input:["text"] }] } } },
    auth:{ local:{ type:"api_key", key:"mock-only" } },
  };
  const runtime = await createSdkRuntime({ config, sdkHistory:[saved.getHeader(), ...saved.getEntries()] });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  const replay = events[0];
  assert.equal(replay.type, "extension_ui");
  assert.deepEqual(replay.state.todo.tasks, [{ id:1, subject:"restored from details", status:"in_progress" }],
    "the real package is identified and its last valid branch snapshot is replayed");
  assert(!replay.state.widgets.some((widget) => widget.key === "rpiv-todos"),
    "the Todo adapter never scrapes the package ANSI widget");
  await runtime.prompt("create another task");
  const updated = events.filter((event) => event.type === "extension_ui" && event.state.todo?.tasks.length === 2).at(-1);
  assert(updated, "the original package tool result publishes a complete structured snapshot");
  assert.deepEqual(updated.state.todo.tasks.map((task) => task.subject),
    ["restored from details", "created by the original package"]);
  assert.equal(events.at(-1).status, "completed");
  console.log("PASS: unmodified @juicesharp/rpiv-todo loads, replays and updates through the SDK UI adapter");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive:true, force:true });
}
