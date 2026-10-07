import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import todoExtension, { TODO_ENTRY_TYPE, applyTaskMutation, replayTodo } from "./extensions/todo/index.js";
import { createSdkRuntime, sdkQuery } from "./sdk.js";

// Exercise the shared reducer and branch restore through the extension's actual registered tool.
const manager = SessionManager.inMemory();
const handlers = new Map();
let tool;
todoExtension({ on: (event, handler) => handlers.set(event, handler),
  registerTool: definition => { tool = definition; },
  appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
const ctx = { sessionManager:manager };
handlers.get("session_start")({}, ctx);
const call = params => tool.execute("check", params);
let result = await call({ action:"create", subject:"A", description:"full description", metadata:{ keep:1, drop:2 } });
const forkPoint = manager.getLeafId();
await call({ action:"create", subject:"B", blockedBy:[1] });
result = await call({ action:"update", id:1, addBlockedBy:[2] });
assert.match(result.details.error, /cycle/);
assert.equal(manager.getEntries().length, 2, "rejected mutations do not persist a snapshot");
await call({ action:"update", id:1, status:"in_progress", activeForm:"doing A", metadata:{ drop:null } });
result = await call({ action:"get", id:1 });
assert.deepEqual(result.details.tasks[0].metadata, { keep:1 });
assert.match(result.content[0].text, /full description/);
const changedLeaf = manager.getLeafId();
manager.branch(forkPoint);
handlers.get("session_tree")({}, ctx);
assert.equal((await call({ action:"list" })).details.tasks.length, 1, "a sibling branch's B is not visible");
assert.equal((await call({ action:"get", id:1 })).details.tasks[0].status, "pending");
manager.branch(changedLeaf);
manager.appendCompaction("summary", changedLeaf, 1000);
handlers.get("session_compact")({}, ctx);
assert.equal((await call({ action:"get", id:1 })).details.tasks[0].activeForm, "doing A",
  "compaction does not discard custom branch state");
await call({ action:"delete", id:2 });
assert.doesNotMatch((await call({ action:"list" })).content[0].text, /#2/);
await call({ action:"clear" });
assert.deepEqual(replayTodo(manager.getBranch()), { tasks:[], nextId:1 }, "clear persists an explicit empty state");
assert.equal(applyTaskMutation({ tasks:[{ id:1, subject:"done", status:"completed" }], nextId:2 },
  "update", { id:1, status:"in_progress" }).op.kind, "error");
console.log("PASS: bundled todo dependencies, metadata, rejected mutations, branch switch, compaction and clear");

// Real SDK + mock HTTP model: codemode nested calls must survive rebuilding the runtime.
const root = await mkdtemp(join(tmpdir(), "launcher-todo-check-"));
const plans = new Map();
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const last = payload.messages.at(-1);
  const prompt = typeof last.content === "string" ? last.content : last.content.map(part => part.text ?? "").join("");
  const plan = last.role === "user" ? plans.get(prompt) : undefined;
  const delta = plan ? { role:"assistant", tool_calls:[{ index:0, id:"todo-check-call", type:"function",
    function:{ name:plan.name, arguments:JSON.stringify(plan.args) } }] } : { role:"assistant", content:"done" };
  response.writeHead(200, { "Content-Type":"text/event-stream" });
  response.end(`data: ${JSON.stringify({ id:"mock", object:"chat.completion.chunk", choices:[{ index:0, delta, finish_reason:null }] })}\n\ndata: ${JSON.stringify({ id:"mock", object:"chat.completion.chunk", choices:[{ index:0, delta:{}, finish_reason:plan ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const config = { agentDir:join(root,"agent"), cwd:join(root,"workspace"), cacheDir:join(root,"cache"),
    settings:{ defaultProvider:"local", defaultModel:"mock", defaultTools:["+codemode"],
      codemode:{ mode:"only" }, compaction:{ enabled:false } },
    models:{ providers:{ local:{ baseUrl:`http://127.0.0.1:${server.address().port}/v1`, api:"openai-completions",
      models:[{ id:"mock", name:"Mock", reasoning:false, input:["text"] }] } } },
    auth:{ local:{ type:"api_key", key:"mock-only" } } };
  const runtime = async command => {
    const instance = await createSdkRuntime({ config, ...command });
    const events = [];
    instance.subscribe(event => events.push(event));
    return { instance, events };
  };
  const run = async (test, prompt, code) => {
    if (code) plans.set(prompt, { name:"codemode", args:{ code } });
    await test.instance.prompt(prompt);
    assert.equal(test.events.at(-1).status, "completed");
    const end = test.events.find(event => event.type === "tool_end" && event.name === "codemode");
    if (code) assert.equal(end?.isError, false, JSON.stringify(end));
    return test.events.find(event => event.type === "context").entries;
  };
  const resources = await sdkQuery({ type:"resources", config });
  assert(resources.extensions.some(extension => extension.path === "builtin:todo"));
  const first = await runtime({});
  const history = await run(first, "create nested",
    'text(await tools.todo({ action:"create", subject:"nested", description:"survives", metadata:{v:7} }));');
  assert.equal(first.events.filter(event => event.type === "extension_ui").at(-1).state.todo.tasks[0].subject, "nested");
  assert(history.some(entry => entry.type === "custom" && entry.customType === TODO_ENTRY_TYPE),
    "nested results must write their own durable state");
  assert(!history.some(entry => entry.message?.role === "toolResult" && entry.message.toolName === "todo"),
    "this scenario exercises nested-only history, not accidental direct calls");
  const second = await runtime({ sdkHistory:history });
  const isolated = await runtime({});
  assert.equal(second.events[0].state.todo.tasks.length, 1);
  assert.equal(isolated.events[0].state.todo.tasks.length, 0, "same cwd does not share another conversation's tasks");
  const [secondHistory] = await Promise.all([
    run(second, "restore and complete", 'text(await tools.todo({action:"get",id:1})); text(await tools.todo({action:"update",id:1,status:"completed"}));'),
    run(isolated, "independent", 'text(await tools.todo({action:"create",subject:"independent"}));'),
  ]);
  assert.match(second.events.find(event => event.type === "tool_end" && event.name === "todo"
    && event.result.details.action === "get").result.content[0].text, /survives/);
  assert.match(second.events.find(event => event.type === "tool_end" && event.name === "codemode")
    .result.content.map(part => part.text ?? "").join("\n"), /survives/,
    "the restored get result also reaches the model through codemode output");
  assert.equal(replayTodo(secondHistory).tasks[0].metadata.v, 7);
  assert.equal(second.events.filter(event => event.type === "extension_ui").at(-1).state.todo.tasks[0].status, "completed");
  const legacy = { package:"@juicesharp/rpiv-todo", tasks:[{ id:1, subject:"legacy UI", status:"pending" }], nextId:2 };
  const migrated = await runtime({ todo:legacy });
  assert.equal(migrated.events[0].state.todo.tasks[0].subject, "legacy UI");
  const migratedHistory = await run(migrated, "import legacy", 'text(await tools.todo({action:"list"}));');
  assert.equal(replayTodo(migratedHistory).tasks[0].subject, "legacy UI");
  const authoritative = await runtime({ sdkHistory:secondHistory, todo:legacy });
  assert.equal(authoritative.events[0].state.todo.tasks[0].subject, "nested", "saved custom entries override old UI projections");
  await run(authoritative, "no tool");
  const disabled = structuredClone(config);
  disabled.settings.extensions = ["-builtin:todo"];
  assert(!(await sdkQuery({ type:"resources", config:disabled })).extensions.some(extension => extension.path === "builtin:todo"));
  console.log("PASS: SDK codemode-only todo, next-turn list/update, isolated concurrent runtimes, legacy import and builtin disable");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive:true, force:true });
}
