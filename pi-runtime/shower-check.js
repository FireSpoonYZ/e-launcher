import assert from "node:assert/strict";
import { createShowerTool } from "./extensions/phone-control/shower.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
const calls = [];
const tool = createShowerTool({ request: async (arguments_, signal) => {
  calls.push(arguments_);
  signal?.throwIfAborted();
  if (arguments_.action === "screenshot") return { ok:true, action:"screenshot", displayId:7,
    width:720, height:1280, dpi:320, imageWidth:360, imageHeight:640, mimeType:"image/png", data:png };
  if (arguments_.action === "paste") throw new Error("虚拟屏按键注入失败");
  return { ok:true, ...arguments_, displayId:7, width:720, height:1280, dpi:320 };
} });

const created = await tool.execute("create", { action:"create" });
assert.match(created.content[0].text, /"displayId":7/);
const screenshot = await tool.execute("shot", { action:"screenshot", maxWidth:360, maxHeight:640 });
assert.deepEqual(screenshot.content, [
  { type:"text", text:"虚拟屏 720×1280；返回图片 360×640。" },
  { type:"image", data:png, mimeType:"image/png" },
]);
assert(!JSON.stringify(screenshot.details).includes(png), "base64 stays in image content only");
await tool.execute("text", { action:"text", text:"不要做挑战" });
await tool.execute("clear-text", { action:"text", text:"" });
await tool.execute("copy", { action:"copy", text:"复制测试" });
await tool.execute("clear", { action:"clear" });
await assert.rejects(tool.execute("paste", { action:"paste" }), /按键注入失败/);
const aborted = new AbortController();
aborted.abort(new Error("cancelled before native dispatch"));
await assert.rejects(tool.execute("abort", { action:"release" }, aborted.signal), /cancelled before native dispatch/);
assert.deepEqual(calls.slice(2), [
  { action:"text", text:"不要做挑战" }, { action:"text", text:"" },
  { action:"copy", text:"复制测试" }, { action:"clear" }, { action:"paste" },
]);
console.log("Operit Shower tool: native dispatch, virtual/image dimensions, image content, errors and cancellation passed");
