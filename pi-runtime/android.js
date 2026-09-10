import net from "node:net";
import { createPiRuntime } from "./index.js";

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
socket.on("close", () => active?.runtime.abort());

async function handle(command) {
  if (command.type === "abort") {
    if (active?.id === command.id) active.runtime.abort();
    return;
  }
  if (command.type !== "prompt" || typeof command.id !== "string") return;
  const id = command.id;
  if (active) {
    send({ id, type: "error", message: "pi 正在结束上一轮请求，请稍后重试", aborted: false });
    send({ id, type: "end", status: "error" });
    return;
  }
  let ended = false;
  try {
    const runtime = createPiRuntime(command);
    active = { id, runtime };
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
      send({ id, type: "error", message: error?.message || String(error), aborted: false });
      send({ id, type: "end", status: "error" });
    }
  } finally {
    if (active?.id === id) active = undefined;
  }
}
