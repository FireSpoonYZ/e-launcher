import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime, loadExtensionFromFactory } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import scheduleTool from "./extensions/schedule-tool/index.js";

const source = await readFile(new URL("./android.js", import.meta.url), "utf8");
assert.match(source, /schedule-tool:bridge/);
assert.match(source, /name: "schedule-tool"/);
assert.match(source, /schedule_request/);
assert.match(source, /schedule_response/);
assert.match(source, /schedule_cancel/);

await assert.rejects(loadExtensionFromFactory(scheduleTool, process.cwd(), createEventBus(),
  createExtensionRuntime(), "<inline:schedule-tool>"), /需要 Android 宿主提供原生 bridge/);

const calls = [];
const eventBus = createEventBus();
eventBus.on("schedule-tool:bridge", (bridge) => {
  bridge.request = async (action, params, signal) => {
    signal?.throwIfAborted();
    calls.push({ action, params, signal });
    if (params.probe === "invalid") return undefined;
    if (action === "delete") throw new Error("此定时任务已删除");
    if (action === "update" && params.revision === 1) throw new Error("任务已更改，请刷新后重试");
    if (action === "create" && params.time === "25:00") throw new Error("请选择有效的执行时间");
    return { tasks: [{ id: params.id ?? "task-1", revision: (params.revision ?? 0) + 1, enabled: true }],
      records: [], exactAlarmGranted: false, schedulingError: "", timeZone: "UTC" };
  };
});
const extension = await loadExtensionFromFactory(scheduleTool, process.cwd(), eventBus,
  createExtensionRuntime(), "<inline:schedule-tool>");
const tool = extension.tools.get("schedule_task").definition;
assert.equal(tool.name, "schedule_task");
assert.match(tool.description, /exactAlarmGranted 为 false/);
assert.match(tool.description, /不要立刻重复提交/);

const listed = await tool.execute("list", { action: "list" });
assert.equal(JSON.parse(listed.content[0].text).exactAlarmGranted, false);
assert.equal(calls[0].action, "list");
assert.deepEqual(calls[0].params, {});
calls.length = 0;

const signal = new AbortController().signal;
const created = await tool.execute("create", { action: "create", title: "早间简报", prompt: "整理资讯",
  repeat: "daily", time: "08:00" }, signal);
assert.equal(JSON.parse(created.content[0].text).tasks[0].revision, 1);
assert.deepEqual(calls[0], { action: "create", params: { title: "早间简报", prompt: "整理资讯",
  repeat: "daily", time: "08:00" }, signal });
calls.length = 0;

await tool.execute("update", { action: "update", id: "task-1", revision: 2, time: "09:30" }, signal);
assert.deepEqual(calls[0].params, { id: "task-1", revision: 2, time: "09:30" });
assert.equal(calls.length, 1, "partial update is one request and does not invent the other fields");
calls.length = 0;

await assert.rejects(tool.execute("stale", { action: "update", id: "task-1", revision: 1, title: "过期" }),
  /任务已更改，请刷新后重试/);
await assert.rejects(tool.execute("missing", { action: "delete", id: "missing", revision: 2 }),
  /此定时任务已删除/);
await assert.rejects(tool.execute("invalid", { action: "create", title: "坏", prompt: "x",
  repeat: "daily", time: "25:00" }), /请选择有效的执行时间/);
assert.equal(calls.length, 3, "errors are returned once and not retried by the tool");
calls.length = 0;

const aborted = new AbortController();
aborted.abort(new Error("cancelled before native dispatch"));
await assert.rejects(tool.execute("abort", { action: "list" }, aborted.signal), /cancelled before native dispatch/);
assert.equal(calls.length, 0, "an aborted tool does not dispatch a schedule mutation");
await assert.rejects(tool.execute("bad", { action: "list", probe: "invalid" }), /定时任务响应无效/);

console.log("schedule_task: built-in load, partial forward, honest errors, no retry and abort-before-dispatch passed");
