import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime, ExtensionRunner, loadExtensionFromFactory } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import showerContext, { pruneShowerContext } from "./extensions/shower-context/index.js";

const source = await readFile(new URL("./android.js", import.meta.url), "utf8");
assert.match(source, /name: "shower-context"/);
assert.doesNotMatch(await readFile(new URL("./extensions/shower-context/index.js", import.meta.url), "utf8"),
  /agent_end|sessionManager/);

const shot = (id, data, details, text = "虚拟屏 720×1280；返回图片 360×640。") => ({
  role: "toolResult", toolCallId: id, toolName: "shower", isError: false, timestamp: 1,
  ...(details === undefined ? {} : { details }),
  content: [{ type: "text", text }, { type: "image", data, mimeType: "image/png" }],
});
const stored = [
  { role: "user", timestamp: 1, content: [{ type: "text", text: "看图" },
    { type: "image", data: "user-shot", mimeType: "image/png" }] },
  { role: "assistant", timestamp: 2, content: [
    { type: "text", text: "先看屏幕" },
    { type: "toolCall", id: "call-old", name: "shower", arguments: { action: "screenshot" } },
    { type: "toolCall", id: "call-corr", name: "shower", arguments: "{\"action\":\"screenshot\"}" },
    { type: "toolCall", id: "call-tap", name: "shower", arguments: { action: "tap", x: 1, y: 2 } },
  ] },
  shot("call-old", "old-shot", { engine: "operit-shower", action: "screenshot", displayId: 7 }),
  shot("call-mid", "mid-shot", { engine: "operit-shower" }, "中间截图"),
  shot("call-corr", "corr-shot", undefined, "只有关联"),
  shot("call-tap", "tap-shot", { engine: "operit-shower", action: "tap" }, "已点击"),
  { role: "toolResult", toolCallId: "call-read", toolName: "read", isError: false, timestamp: 1,
    details: { file: "a.png" }, content: [{ type: "text", text: "文件" },
      { type: "image", data: "other-shot", mimeType: "image/png" }] },
  shot("call-new", "new-shot", { engine: "operit-shower", action: "screenshot", width: 720 }),
];
const snapshot = structuredClone(stored);
const direct = pruneShowerContext(stored);
assert.equal(direct[0], stored[0]);
assert.equal(direct.at(-1), stored.at(-1));
assert.notEqual(direct[2], stored[2]);
assert.equal(direct[2].toolCallId, "call-old");
assert.equal(direct[2].details, stored[2].details);
assert.deepEqual(direct[2].content, [
  { type: "text", text: "虚拟屏 720×1280；返回图片 360×640。" },
  { type: "text", text: "[历史截图已省略，仅保留最新截图]" },
]);
for (const id of ["call-mid", "call-corr"]) {
  const message = direct.find((item) => item.toolCallId === id);
  assert.equal(message.content.some((part) => part.type === "image"), false);
  assert.match(message.content.at(-1).text, /历史截图已省略/);
  assert.equal(message.toolCallId, id);
}
assert.equal(direct.find((item) => item.toolCallId === "call-tap").content[1].data, "tap-shot");
assert.equal(direct.find((item) => item.toolCallId === "call-read").content[1].data, "other-shot");
assert.equal(direct[0].content[1].data, "user-shot");
assert.equal(direct.at(-1).content[1].data, "new-shot");
assert.equal(direct.at(-1).content[0].text, stored.at(-1).content[0].text);
assert.deepEqual(stored, snapshot, "pruning must not change the caller's history");
const single = [stored.at(-1)];
assert.equal(pruneShowerContext(single), single);
assert.deepEqual(pruneShowerContext(stored), direct, "a later call still prunes from the original images");

const sessionManager = {
  getBranch() { throw new Error("context hook read session branch"); },
  getEntries() { throw new Error("context hook read session entries"); },
};
const extension = await loadExtensionFromFactory(showerContext, process.cwd(), createEventBus(),
  createExtensionRuntime(), "<inline:shower-context>");
assert.equal(extension.handlers.has("agent_end"), false);
assert.equal(extension.handlers.get("context")?.length, 1);
const runner = new ExtensionRunner([extension], createExtensionRuntime(), process.cwd(), sessionManager, {});
const errors = [];
runner.onError((error) => errors.push(error));
const first = await runner.emitContext(stored);
const second = await runner.emitContext(stored);
assert.deepEqual(errors, []);
assert.deepEqual(first, direct);
assert.deepEqual(second, first);
assert.deepEqual(stored, snapshot);
assert.equal(stored[2].content[1].data, "old-shot");

console.log("shower-context: context copy prunes older Shower screenshots and leaves stored history unchanged");
