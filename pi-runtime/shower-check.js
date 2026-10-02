import assert from "node:assert/strict";
import { runToolCall } from "./node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js";
import { executeCodemode } from "./node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js";
import { createShowerTool } from "./extensions/phone-control/shower.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
const calls = [];
const tool = createShowerTool({ request: async (arguments_, signal) => {
  calls.push(arguments_);
  signal?.throwIfAborted();
  if (arguments_.action === "screenshot" && arguments_.maxWidth === 160) return { mimeType:"text/plain", data:"x" };
  if (arguments_.action === "screenshot") return { ok:true, action:"screenshot", displayId:7,
    width:720, height:1280, dpi:320, imageWidth:360, imageHeight:640, mimeType:"image/png", data:png };
  if (arguments_.action === "paste") throw new Error("虚拟屏按键注入失败");
  return { ok:true, ...arguments_, displayId:7, width:720, height:1280, dpi:320 };
} });

assert.match(tool.description, /image\(shot\.image\)/);
assert.doesNotMatch(tool.description, /text\(shot\.image\.data\)|return shot\.image\.data/);
assert.equal(tool.outputSchema.anyOf[0].properties.image.properties.type.const, "image");
assert.equal(tool.outputSchema.anyOf[1].type, "string");
assert.equal(tool.outputSchema.properties, undefined, "screenshot schema must not look like an MCP CallToolResult");
const created = await tool.execute("create", { action:"create" });
assert.match(created.content[0].text, /"displayId":7/);
assert.equal(created.structuredContent, created.content[0].text);
const screenshot = await tool.execute("shot", { action:"screenshot", maxWidth:360, maxHeight:640 });
assert.deepEqual(screenshot.content, [
  { type:"text", text:"虚拟屏 720×1280；返回图片 360×640。" },
  { type:"image", data:png, mimeType:"image/png" },
]);
assert.deepEqual(screenshot.structuredContent, {
  ok:true, action:"screenshot", displayId:7, width:720, height:1280, dpi:320,
  imageWidth:360, imageHeight:640, image: screenshot.content[1],
});
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

const codemode = (code) => executeCodemode("codemode-shot", { code }, undefined, undefined, {
  tools: [tool],
  sessionManager: { getBranch: () => [] },
  executeTool: (name, args, options) => runToolCall(
    { type: "toolCall", id: `${name}-nested`, name, arguments: args ?? {} },
    { tools: [tool], assistantMessage: { role: "assistant", content: [] }, context: { messages: [] },
      signal: options?.signal },
  ),
});
const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const shot = await codemode(`
  const shot = await tools.shower({ action: "screenshot", maxWidth: 360, maxHeight: 640 });
  if (typeof shot !== "object" || shot?.image?.type !== "image") throw new Error("screenshot was " + typeof shot);
  image(shot.image);
  text("dims " + shot.width + "x" + shot.imageWidth);
`);
assert.equal(shot.isError, undefined);
assert.deepEqual(shot.content.find((part) => part.type === "image"), { type:"image", data:png, mimeType:"image/png" });
assert.match(textOf(shot), /dims 720x360/);
assert.doesNotMatch(textOf(shot), /iVBORw0KGgo/, "script text must not carry the screenshot base64");
const other = await codemode(`
  const value = await tools.shower({ action: "create" });
  text(typeof value);
  return value;
`);
assert.equal(other.isError, undefined);
assert.equal(other.content.some((part) => part.type === "image"), false);
assert.match(textOf(other), /string/);
assert.match(textOf(other), /"action":"create"/);
const failed = await codemode(`await tools.shower({ action: "paste" }); text("after-error");`);
assert.equal(failed.isError, true);
assert.match(textOf(failed), /按键注入失败/);
assert.doesNotMatch(textOf(failed), /after-error/);
assert.equal(failed.content.some((part) => part.type === "image"), false);
const invalid = await codemode(`await tools.shower({ action: "screenshot", maxWidth: 160 }); text("after-invalid");`);
assert.equal(invalid.isError, true);
assert.match(textOf(invalid), /截图响应无效/);
assert.doesNotMatch(textOf(invalid), /after-invalid/);
console.log("Operit Shower tool: native dispatch, virtual/image dimensions, image content, codemode image(), non-screenshot text, errors and cancellation passed");
