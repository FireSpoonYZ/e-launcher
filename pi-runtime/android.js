import net from "node:net";
import { randomUUID } from "node:crypto";
import { createPiRuntime } from "./index.js";
import { createSdkRuntime, sdkQuery } from "./sdk.js";

const endpoint = process.argv[2];
const socket = net.createConnection({ path: endpoint.startsWith("@") ? `\0${endpoint.slice(1)}` : endpoint });
let input = "";
let active;
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
socket.on("close", () => { active?.controller.abort(); active?.runtime?.abort(); });

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
      send({ id: operation.id, type: "auth_prompt", promptId, prompt: { ...prompt, signal: undefined } });
    });
  } finally {
    signal.removeEventListener("abort", aborted);
    operation.prompts.delete(promptId);
    send({ id: operation.id, type: "auth_prompt_end", promptId });
  }
}

async function handle(command) {
  if (command.type === "abort") {
    if (active?.id === command.id) { active.controller.abort(); active.runtime?.abort(); }
    return;
  }
  if (command.type === "auth_reply") {
    if (active?.id !== command.id) return;
    const pending = active.prompts.get(command.promptId);
    if (pending) {
      if (command.cancelled) active.controller.abort();
      else if (typeof command.value === "string") pending(command.value);
    }
    return;
  }
  if (typeof command.id !== "string") return;
  const id = command.id;
  if (active) {
    send({ id, type: "error", message: "pi 正在结束上一轮请求，请稍后重试", aborted: false });
    send({ id, type: "end", status: "error" });
    return;
  }
  let ended = false;
  const controller = new AbortController();
  const operation = { id, controller, prompts: new Map() };
  active = operation;
  try {
    if (command.type !== "prompt") {
      const result = await sdkQuery(command, controller.signal, (event) => send({ ...event, id }), (prompt) => requestAuth(prompt, operation));
      send({ id, type: "result", result });
      send({ id, type: "end", status: "completed" });
      return;
    }
    const runtime = command.sdk ? await createSdkRuntime(command, controller.signal) : createPiRuntime(command);
    active.runtime = runtime;
    runtime.subscribe((event) => {
      if (ended) return;
      if (event.type === "end") {
        ended = true;
        if (active?.id === id) active = undefined;
      }
      send({ ...event, id });
    });
    await runtime.prompt(command.prompt);
  } catch (error) {
    if (!ended) {
      send({ id, type: "error", message: error?.message || String(error), aborted: controller.signal.aborted });
      send({ id, type: "end", status: controller.signal.aborted ? "aborted" : "error" });
    }
  } finally {
    if (active?.id === id) active = undefined;
  }
}
