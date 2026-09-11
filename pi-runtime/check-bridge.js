import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

const home = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-check-"));
const requests = [];

// Exercise the shipped CJS entry, not just the source Agent wrapper.
const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\pi-check-${process.pid}`
  : path.join(os.tmpdir(), `pi-check-${process.pid}.sock`);
const events = [];
const waiters = new Set();
const held = new Set();
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    if (payload.model === "mock") assert(!Object.hasOwn(payload, "max_tokens") && !Object.hasOwn(payload, "max_completion_tokens"));
    const content = payload.messages.at(-1).content;
    const prompt = typeof content === "string" ? content : content.map((part) => part.text || "").join("");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: "mock", object: "chat.completion.chunk", created: 1, model: "mock",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    emit({ role: "assistant", content: "bridge ok" });
    if (prompt === "hold") {
      held.add(res);
      res.on("close", () => held.delete(res));
    } else if (prompt === "tool") {
      emit({ tool_calls: [{ index: 0, id: "probe-1", type: "function", function: { name: "probe", arguments: "{}" } }] }, "tool_calls");
      res.end("data: [DONE]\n\n");
    } else {
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
  const prompt = (id, text) => send({ type: "prompt", id, prompt: text, history: [],
    baseUrl: `http://127.0.0.1:${api.address().port}/v1`, apiKey: "synthetic", modelId: "mock" });
  prompt("a", "hold");
  await waitFor((event) => event.id === "a" && event.type === "text_delta");
  prompt("busy", "normal");
  assert.equal((await waitFor((event) => event.id === "busy" && event.type === "end")).status, "error");
  send({ type: "abort", id: "a" });
  assert.equal((await waitFor((event) => event.id === "a" && event.type === "end")).status, "aborted");
  prompt("b", "normal");
  assert.equal((await waitFor((event) => event.id === "b" && event.type === "end")).status, "completed");
  assert.equal(events.find((event) => event.id === "b" && event.type === "message").message.content, "bridge ok");
  for (const id of ["a", "busy", "b"]) assert.equal(events.filter((event) => event.id === id && event.type === "end").length, 1);
  assert(events.filter((event) => event.type !== "ready").every((event) => typeof event.id === "string"));
  console.log("PASS: shipped CJS bridge ready, request IDs, busy rejection, abort and subsequent completion");
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
    }
  `);
  send({ id: "catalog", type: "catalog", config });
  assert.equal((await waitFor((event) => event.id === "catalog" && event.type === "end")).status, "completed", JSON.stringify(events));
  assert(events.find((event) => event.id === "catalog" && event.type === "result").result.some((provider) => provider.id === "local"));
  assert(events.find((event) => event.id === "catalog" && event.type === "result").result.some((provider) => provider.id === "extension-local"));
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
  send({ id: "sdk-tool", type: "prompt", sdk: true, prompt: "tool", config });
  assert.equal((await waitFor((event) => event.id === "sdk-tool" && event.type === "end")).status, "completed", JSON.stringify(events));
  assert.equal(requests.at(-1).reasoning_effort, "high");
  assert(events.some((event) => event.id === "sdk-tool" && event.type === "tool_start" && event.name === "probe"));
  const sdkHistory = events.find((event) => event.id === "sdk-tool" && event.type === "context").entries;
  assert.equal(sdkHistory[0].type, "session");
  assert(sdkHistory.some((entry) => entry.message?.role === "toolResult"));
  send({ id: "sdk-next", type: "prompt", sdk: true, prompt: "normal", config, sdkHistory });
  assert.equal((await waitFor((event) => event.id === "sdk-next" && event.type === "end")).status, "completed", JSON.stringify(events));
  assert(requests.at(-1).messages.some((message) => message.role === "tool"), "native tool results survive across bridge requests");
  send({ id: "sdk-hold", type: "prompt", sdk: true, prompt: "hold", config });
  await waitFor((event) => event.id === "sdk-hold" && event.type === "text_delta");
  send({ id: "sdk-hold", type: "abort" });
  assert.equal((await waitFor((event) => event.id === "sdk-hold" && event.type === "end")).status, "aborted");
  console.log("PASS: bundled SDK registry, TypeScript extension/tool execution, reasoning, native context and abort");
} finally {
  socket?.destroy();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  for (const response of held) response.destroy();
  api.closeAllConnections();
  await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => server.close(resolve))]);
  await rm(home, { recursive: true, force: true });
}
