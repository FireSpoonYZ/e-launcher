import net from "node:net";
import { randomUUID } from "node:crypto";
import { createPiRuntime } from "./index.js";
import { createSdkRuntime, sdkQuery } from "./sdk.js";

// cross-spawn otherwise changes the process cwd temporarily while resolving cwd-bound commands.
// That is unsafe when independent session runtimes execute concurrently in this process.
if (typeof process.chdir === "function") process.chdir.disabled = true;

const endpoint = process.argv[2];
const socket = net.createConnection({ path: endpoint.startsWith("@") ? `\0${endpoint.slice(1)}` : endpoint });
let input = "";
const operations = new Map();
const sessions = new Map();
const send = (value) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\n");
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); }
    catch { socket.destroy(); }
  }
});
socket.on("connect", () => send({ type: "ready", node: process.version }));
socket.on("error", (error) => console.error(`pi bridge socket: ${error.message}`));
socket.on("close", () => {
  for (const operation of operations.values()) {
    operation.controller.abort();
    operation.runtime?.abort();
  }
});

async function requestAuth(prompt, operation) {
  const signal = prompt.signal ? AbortSignal.any([prompt.signal, operation.controller.signal]) : operation.controller.signal;
  signal.throwIfAborted();
  const promptId = randomUUID();
  let aborted;
  try {
    return await new Promise((resolve, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      operation.prompts.set(promptId, resolve);
      send({ id: operation.id, conversationId: operation.conversationId,
        type: "auth_prompt", promptId, prompt: { ...prompt, signal: undefined } });
    });
  } finally {
    signal.removeEventListener("abort", aborted);
    operation.prompts.delete(promptId);
    send({ id: operation.id, conversationId: operation.conversationId, type: "auth_prompt_end", promptId });
  }
}

function requestShower(operation, arguments_, signal) {
  const combined = signal ? AbortSignal.any([signal, operation.controller.signal])
    : operation.controller.signal;
  combined.throwIfAborted();
  const callId = randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      combined.removeEventListener("abort", onAbort);
      operation.nativeCalls.delete(callId);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      send({ type: "shower_cancel", id: operation.id, callId });
      finish(combined.reason instanceof Error ? combined.reason : new Error("Shower 工具已取消"));
    };
    const timeout = setTimeout(() => {
      send({ type: "shower_cancel", id: operation.id, callId });
      finish(new Error("Shower 原生操作 20 秒内未完成；先重新 create/screenshot 确认状态"));
    }, 20_000);
    operation.nativeCalls.set(callId, { finish });
    combined.addEventListener("abort", onAbort, { once: true });
    send({ type: "shower_request", id: operation.id, conversationId: operation.conversationId,
      callId, arguments: arguments_ });
  });
}

async function handle(command) {
  if (command.type === "shower_response") {
    const operation = operations.get(command.id);
    const pending = operation?.nativeCalls.get(command.callId);
    if (pending) pending.finish(command.error ? new Error(command.error) : undefined, command.result);
    return;
  }
  if (command.type === "abort") {
    const operation = operations.get(command.id);
    if (operation) { operation.controller.abort(); operation.runtime?.abort(); }
    return;
  }
  if (command.type === "auth_reply") {
    const operation = operations.get(command.id);
    if (!operation) return;
    const pending = operation.prompts.get(command.promptId);
    if (pending) {
      if (command.cancelled) operation.controller.abort();
      else if (typeof command.value === "string") pending(command.value);
    }
    return;
  }
  if (typeof command.id !== "string") return;
  const id = command.id;
  const conversationId = command.type === "prompt" && typeof command.conversationId === "string"
    ? command.conversationId : undefined;
  if (operations.has(id) || (conversationId && sessions.has(conversationId))) {
    send({ id, conversationId, type: "error", message: "此会话已有一轮正在运行", aborted: false });
    send({ id, conversationId, type: "end", status: "error" });
    return;
  }
  let ended = false;
  const controller = new AbortController();
  const operation = { id, conversationId, controller, prompts: new Map(), nativeCalls: new Map() };
  const sendEvent = (event) => send({ ...event, id, conversationId });
  operations.set(id, operation);
  if (conversationId) sessions.set(conversationId, operation);
  try {
    if (command.type !== "prompt") {
      const result = await sdkQuery(command, controller.signal, sendEvent,
        (prompt) => requestAuth(prompt, operation));
      sendEvent({ type: "result", result });
      sendEvent({ type: "end", status: "completed" });
      ended = true;
      return;
    }
    const runtime = command.sdk ? await createSdkRuntime(command, controller.signal,
      (arguments_, signal) => requestShower(operation, arguments_, signal)) : createPiRuntime(command);
    operation.runtime = runtime;
    runtime.subscribe((event) => {
      if (ended) return;
      if (event.type === "end") ended = true;
      sendEvent(event);
    });
    await runtime.prompt(command.prompt);
  } catch (error) {
    if (!ended) {
      sendEvent({ type: "error", message: error?.message || String(error), aborted: controller.signal.aborted });
      sendEvent({ type: "end", status: controller.signal.aborted ? "aborted" : "error" });
    }
  } finally {
    if (operations.get(id) === operation) operations.delete(id);
    if (conversationId && sessions.get(conversationId) === operation) sessions.delete(conversationId);
  }
}
