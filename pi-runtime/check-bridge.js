import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";

const home = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-check-"));
const requests = [];
let extensionFetches = 0;

// Exercise the shipped CJS entry, not just the source Agent wrapper.
const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\pi-check-${process.pid}`
  : path.join(os.tmpdir(), `pi-check-${process.pid}.sock`);
const events = [];
const waiters = new Set();
const held = new Set();
const api = http.createServer((req, res) => {
  if (req.url === "/extension-init") {
    extensionFetches++;
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("initialized");
      }
    }, 1_500);
    return;
  }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    if (payload.model === "mock") assert(!Object.hasOwn(payload, "max_tokens") && !Object.hasOwn(payload, "max_completion_tokens"));
    const text = (content) => typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => part.text || "").join("") : "";
    const prompt = payload.messages.filter((message) => message.role === "user")
      .map((message) => text(message.content)).find((value) => /^(cwd:|timeout-A)/.test(value))
      ?? text(payload.messages.at(-1).content);
    const called = payload.messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: "mock", object: "chat.completion.chunk", created: 1, model: "mock",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const tool = (name, args) => {
      emit({ tool_calls: [{ index: 0, id: `${name}-${prompt}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
      res.end("data: [DONE]\n\n");
    };
    if (prompt === "hold") {
      emit({ role: "assistant", content: "bridge ok" });
      held.add(res);
      res.on("close", () => held.delete(res));
    } else if (prompt === "tool") {
      emit({ role: "assistant", content: "bridge ok" });
      emit({ tool_calls: [
        { index: 0, id: "probe-1", type: "function", function: { name: "probe", arguments: "{}" } },
        { index: 1, id: "probe-2", type: "function", function: { name: "probe", arguments: "{}" } },
      ] }, "tool_calls");
      res.end("data: [DONE]\n\n");
    } else if (prompt.startsWith("cwd:")) {
      const marker = prompt.slice(4);
      if (!called.includes("write")) tool("write", { path: "marker.txt", content: marker });
      else if (!called.includes("read")) tool("read", { path: "marker.txt" });
      else if (!called.includes("bash")) tool("bash", {
        command: "node -e \"require('node:fs').writeFileSync('bash-marker.txt',process.cwd())\"",
      });
      else {
        emit({ role: "assistant", content: "cwd-ok" }); emit({}, "stop"); res.end("data: [DONE]\n\n");
      }
    } else if (prompt === "timeout-A" && !called.includes("delay")) {
      tool("delay", {});
    } else if (prompt === "timeout-A") {
      res.flushHeaders();
      setTimeout(() => {
        emit({ role: "assistant", content: "timeout-ok" }); emit({}, "stop"); res.end("data: [DONE]\n\n");
      }, 100);
    } else {
      emit({ role: "assistant", content: "bridge ok" });
      emit({}, "stop");
      res.end("data: [DONE]\n\n");
    }
  });
});
const server = net.createServer();
let child;
let socket;
let stderr = "";
function waitFor(predicate) {
  const found = events.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const check = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout); waiters.delete(check); resolve(event);
    };
    const timeout = setTimeout(() => {
      waiters.delete(check); reject(new Error(`Bridge event timeout: ${stderr}`));
    }, 15000);
    waiters.add(check);
  });
}
try {
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  server.listen(endpoint); await once(server, "listening");
  const connected = once(server, "connection", { signal: AbortSignal.timeout(15000) });
  child = spawn(process.execPath, [fileURLToPath(new URL("../app/src/main/assets/pi-runtime.cjs", import.meta.url)), endpoint],
    { stdio: ["ignore", "ignore", "pipe"], cwd: home,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent") } });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (text) => { stderr += text; });
  [socket] = await connected;
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    input += chunk;
    for (let end; (end = input.indexOf("\n")) >= 0;) {
      const event = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      events.push(event); for (const check of waiters) check(event);
    }
  });
  await waitFor((event) => event.type === "ready");
  const send = (command) => socket.write(`${JSON.stringify(command)}\n`);
  const prompt = (id, text, conversationId = id) => send({ type: "prompt", id, conversationId,
    prompt: text, history: [], baseUrl: `http://127.0.0.1:${api.address().port}/v1`,
    apiKey: "synthetic", modelId: "mock" });
  prompt("a", "hold");
  await waitFor((event) => event.id === "a" && event.type === "text_delta");
  prompt("concurrent", "normal");
  assert.equal((await waitFor((event) => event.id === "concurrent" && event.type === "end")).status, "completed");
  assert.equal(events.filter((event) => event.id === "a" && event.type === "end").length, 0,
    "another session completes without ending the held session");
  prompt("same-session", "normal", "a");
  assert.equal((await waitFor((event) => event.id === "same-session" && event.type === "end")).status, "error");
  send({ type: "abort", id: "a" });
  assert.equal((await waitFor((event) => event.id === "a" && event.type === "end")).status, "aborted");
  prompt("after-abort", "normal", "a");
  assert.equal((await waitFor((event) => event.id === "after-abort" && event.type === "end")).status, "completed");
  prompt("b", "normal");
  assert.equal((await waitFor((event) => event.id === "b" && event.type === "end")).status, "completed");
  assert.equal(events.find((event) => event.id === "b" && event.type === "message").message.content, "bridge ok");
  for (const id of ["a", "concurrent", "same-session", "after-abort", "b"])
    assert.equal(events.filter((event) => event.id === id && event.type === "end").length, 1);
  assert(events.filter((event) => event.type !== "ready").every((event) => typeof event.id === "string"));
  assert(events.filter((event) => ["a", "concurrent", "same-session", "after-abort", "b"].includes(event.id))
    .every((event) => typeof event.conversationId === "string"));
  console.log("PASS: shipped CJS bridge request/session routing, cross-session concurrency, same-session exclusion and abort");
  const config = { agentDir: path.join(home, "agent"), cwd: path.join(home, "workspace"), cacheDir: path.join(home, "cache"),
    settings: { defaultProvider: "local", defaultModel: "sdk-mock", defaultThinkingLevel: "high", defaultTools: ["probe"], compaction: { enabled: false } },
    models: { providers: { local: { baseUrl: `http://127.0.0.1:${api.address().port}/v1`, api: "openai-completions",
      models: [{ id: "sdk-mock", reasoning: true }] } } }, auth: { local: { type: "api_key", key: "synthetic" } } };
  await mkdir(path.join(config.agentDir, "extensions"), { recursive: true });
  await writeFile(path.join(config.agentDir, "extensions", "probe.ts"), `
    import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
    import { Type } from "typebox";
    export default function(pi: ExtensionAPI) {
      pi.registerProvider("extension-local", {baseUrl:"http://127.0.0.1:${api.address().port}/v1",api:"openai-completions",apiKey:"synthetic",
        models:[{id:"sdk-mock",name:"SDK mock",reasoning:true,input:["text"],
          cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024}]});
      pi.registerProvider({id:"fixture-oauth",name:"Fixture OAuth",getModels:()=>[],
        stream:()=>{throw new Error("unused")},streamSimple:()=>{throw new Error("unused")},
        auth:{oauth:{name:"Fixture OAuth",login:async interaction=>{
          interaction.notify({type:"auth_url",url:"http://127.0.0.1/fixture-login"});
          const access=await interaction.prompt({type:"manual_code",message:"Fixture code"});
          return {type:"oauth",access,refresh:"fixture-refresh",expires:Date.now()+3600000};
        },refresh:async credential=>credential,toAuth:credential=>({apiKey:credential.access})}}});
      pi.registerTool({name:"probe",label:"Probe",description:"Local test tool",parameters:Type.Object({}),
        execute:async()=>({content:[{type:"text",text:"probe-ok"}]})});
      pi.registerTool({name:"delay",label:"Delay",description:"Wait for the interleaving fixture",parameters:Type.Object({}),
        execute:async()=>{await new Promise(resolve=>setTimeout(resolve,300));return {content:[{type:"text",text:"delay-ok"}]}}});
    }
  `);
  send({ id: "catalog", type: "catalog", config });
  assert.equal((await waitFor((event) => event.id === "catalog" && event.type === "end")).status, "completed", JSON.stringify(events));
  assert(events.find((event) => event.id === "catalog" && event.type === "result").result.some((provider) => provider.id === "local"));
  assert(events.find((event) => event.id === "catalog" && event.type === "result").result.some((provider) => provider.id === "extension-local"));
  send({ id: "test-provider", type: "test_provider", providerId: "local", config });
  assert.equal((await waitFor((event) => event.id === "test-provider" && event.type === "end")).status, "completed");
  send({ id: "login", type: "login", providerId: "fixture-oauth", authType: "oauth", config });
  const loginPrompt = await waitFor((event) => event.id === "login" && event.type === "auth_prompt");
  send({ id: "login", type: "auth_reply", promptId: loginPrompt.promptId, value: "synthetic-code" });
  assert.equal((await waitFor((event) => event.id === "login" && event.type === "end")).status, "completed", JSON.stringify(events));
  config.auth["fixture-oauth"] = events.find((event) => event.id === "login" && event.type === "credential").value;
  assert.equal(config.auth["fixture-oauth"].access, "synthetic-code");
  send({ id: "logout", type: "logout", providerId: "fixture-oauth", config });
  assert.equal((await waitFor((event) => event.id === "logout" && event.type === "end")).status, "completed");
  assert.equal(events.find((event) => event.id === "logout" && event.type === "credential").value, null);
  delete config.auth["fixture-oauth"];
  send({ id: "login-cancel", type: "login", providerId: "fixture-oauth", authType: "oauth", config });
  await waitFor((event) => event.id === "login-cancel" && event.type === "auth_prompt");
  send({ id: "login-cancel", type: "abort" });
  assert.equal((await waitFor((event) => event.id === "login-cancel" && event.type === "end")).status, "aborted");
  config.settings.defaultProvider = "extension-local";
  send({ id: "sdk-tool", conversationId: "sdk-session", type: "prompt", sdk: true, prompt: "tool", config });
  assert.equal((await waitFor((event) => event.id === "sdk-tool" && event.type === "end")).status, "completed", JSON.stringify(events));
  assert.equal(requests.at(-1).reasoning_effort, "high");
  const toolStarts = events.filter((event) => event.id === "sdk-tool" && event.type === "tool_start");
  const toolEnds = events.filter((event) => event.id === "sdk-tool" && event.type === "tool_end");
  assert.deepEqual(toolStarts.map((event) => ({ id: event.toolCallId, name: event.name, args: event.args })), [
    { id: "probe-1", name: "probe", args: {} }, { id: "probe-2", name: "probe", args: {} },
  ]);
  assert.deepEqual(toolEnds.map((event) => event.toolCallId).sort(), ["probe-1", "probe-2"]);
  assert(toolEnds.every((event) => event.result.content[0].text === "probe-ok"));
  const canonical = events.filter((event) => event.id === "sdk-tool" && event.type === "message").map((event) => event.message);
  assert.deepEqual(canonical.map((message) => message.role), ["assistant", "tool", "tool", "assistant"]);
  assert.equal(canonical[0].stopReason, "toolUse");
  assert.deepEqual(canonical[0].toolCalls, [
    { id: "probe-1", name: "probe", arguments: "{}" },
    { id: "probe-2", name: "probe", arguments: "{}" },
  ]);
  assert.deepEqual(canonical.slice(1, 3).map((message) => message.toolCallId), ["probe-1", "probe-2"]);
  assert.equal(canonical[3].stopReason, "stop");
  assert(canonical.slice(1, 3).every((message) => message.content === "probe-ok"));
  const sdkHistory = events.find((event) => event.id === "sdk-tool" && event.type === "context").entries;
  assert.equal(sdkHistory[0].type, "session");
  assert(sdkHistory.some((entry) => entry.message?.role === "toolResult"));
  send({ id: "sdk-next", conversationId: "sdk-session", type: "prompt", sdk: true, prompt: "normal", config, sdkHistory });
  assert.equal((await waitFor((event) => event.id === "sdk-next" && event.type === "end")).status, "completed", JSON.stringify(events));
  assert(requests.at(-1).messages.some((message) => message.role === "tool"), "native tool results survive across bridge requests");
  const cwdA = structuredClone(config), cwdB = structuredClone(config);
  cwdA.cwd = path.join(home, "cwd-a"); cwdB.cwd = path.join(home, "cwd-b");
  for (const value of [cwdA, cwdB]) {
    value.selection = { provider: "local", model: "sdk-mock", thinkingLevel: "off" };
    value.settings.defaultTools = ["read", "write", "bash"];
  }
  send({ id: "cwd-a", conversationId: "cwd-a", type: "prompt", sdk: true, prompt: "cwd:A", config: cwdA });
  send({ id: "cwd-b", conversationId: "cwd-b", type: "prompt", sdk: true, prompt: "cwd:B", config: cwdB });
  assert.equal((await waitFor((event) => event.id === "cwd-a" && event.type === "end")).status, "completed");
  assert.equal((await waitFor((event) => event.id === "cwd-b" && event.type === "end")).status, "completed");
  assert.equal(await readFile(path.join(cwdA.cwd, "marker.txt"), "utf8"), "A");
  assert.equal(await readFile(path.join(cwdB.cwd, "marker.txt"), "utf8"), "B");
  assert.equal(await readFile(path.join(cwdA.cwd, "bash-marker.txt"), "utf8"), cwdA.cwd);
  assert.equal(await readFile(path.join(cwdB.cwd, "bash-marker.txt"), "utf8"), cwdB.cwd);
  assert(events.filter((event) => ["cwd-a", "cwd-b"].includes(event.id) && event.type === "tool_end"
    && event.name === "read").every((event) => event.result.content[0].text.includes(event.id.endsWith("a") ? "A" : "B")));

  const timeoutA = structuredClone(config), timeoutB = structuredClone(config);
  timeoutA.settings.httpIdleTimeoutMs = 1_000; timeoutA.settings.defaultTools = ["delay"];
  timeoutB.settings.httpIdleTimeoutMs = 20;
  send({ id: "timeout-a", conversationId: "timeout-a", type: "prompt", sdk: true, prompt: "timeout-A", config: timeoutA });
  await waitFor((event) => event.id === "timeout-a" && event.type === "tool_start" && event.name === "delay");
  send({ id: "timeout-b", conversationId: "timeout-b", type: "prompt", sdk: true, prompt: "normal", config: timeoutB });
  assert.equal((await waitFor((event) => event.id === "timeout-b" && event.type === "end")).status, "completed");
  assert.equal((await waitFor((event) => event.id === "timeout-a" && event.type === "end")).status, "completed",
    "A's second provider request keeps A's timeout after B interleaves");

  const otherConfig = structuredClone(config);
  otherConfig.cwd = path.join(home, "other-workspace");
  send({ id: "sdk-hold", conversationId: "sdk-held-session", type: "prompt", sdk: true, prompt: "hold", config });
  await waitFor((event) => event.id === "sdk-hold" && event.type === "text_delta");
  send({ id: "sdk-concurrent", conversationId: "sdk-other-session", type: "prompt", sdk: true,
    prompt: "normal", config: otherConfig });
  assert.equal((await waitFor((event) => event.id === "sdk-concurrent" && event.type === "end")).status, "completed");
  assert.equal(events.filter((event) => event.id === "sdk-hold" && event.type === "end").length, 0);
  send({ id: "sdk-hold", type: "abort" });
  assert.equal((await waitFor((event) => event.id === "sdk-hold" && event.type === "end")).status, "aborted");
  send({ id: "sdk-after-abort", conversationId: "sdk-held-session", type: "prompt", sdk: true,
    prompt: "normal", config });
  assert.equal((await waitFor((event) => event.id === "sdk-after-abort" && event.type === "end")).status, "completed",
    "the same SDK session accepts a new turn after its aborted end");

  const initExtension = path.join(config.agentDir, "extensions", "init-fetch.ts");
  await writeFile(initExtension, `
    import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
    export default async function(_pi: ExtensionAPI) {
      await fetch("http://127.0.0.1:${api.address().port}/extension-init");
    }
  `);
  const initConfig = structuredClone(config);
  initConfig.settings.httpIdleTimeoutMs = 20;
  send({ id: "extension-init-fetch", type: "resources", config: initConfig });
  assert.equal((await waitFor((event) => event.id === "extension-init-fetch" && event.type === "end")).status,
    "completed");
  const initResult = events.find((event) => event.id === "extension-init-fetch" && event.type === "result").result;
  assert.equal(extensionFetches, 1, "the async extension factory performs a real HTTP request");
  assert(initResult.errors.some((error) => String(error.path).endsWith("init-fetch.ts")
    && /fetch failed|timeout|headers/i.test(String(error.error))),
  `extension initialization uses its runtime HTTP timeout: ${JSON.stringify(initResult.errors)}`);
  await rm(initExtension, { force: true });

  assert.equal((await readdir(config.cacheDir)).filter(name => name.startsWith("pi-request-")).length, 0,
    "completed and aborted turns dispose their per-turn services before end");
  assert(events.filter((event) => event.id === "sdk-concurrent").every((event) => event.conversationId === "sdk-other-session"));
  console.log("PASS: bundled SDK native resume, runtime-scoped provider/extension HTTP, real cwd tools and abort reuse");
} finally {
  socket?.destroy();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  for (const response of held) response.destroy();
  api.closeAllConnections();
  await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => server.close(resolve))]);
  await rm(home, { recursive: true, force: true });
}
