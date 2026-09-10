import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

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
    assert(!Object.hasOwn(payload, "max_tokens") && !Object.hasOwn(payload, "max_completion_tokens"));
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
    { stdio: ["ignore", "ignore", "pipe"] });
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
} finally {
  socket?.destroy();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  for (const response of held) response.destroy();
  api.closeAllConnections();
  await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => server.close(resolve))]);
}
