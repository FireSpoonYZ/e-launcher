import assert from "node:assert/strict";
import { createAppTools } from "./apps.js";

const calls = [];
const tools = createAppTools({ request:async (arguments_, signal) => {
  signal?.throwIfAborted();
  calls.push(arguments_);
  return arguments_.action === "list"
    ? [{ label:"Settings", packageName:"com.android.settings", ignored:"not exposed" }]
    : [{ label:"Camera", packageName:"com.android.camera" }];
} });
assert.deepEqual(tools.map((tool) => tool.name), ["list_apps", "search_apps"]);
assert.match(tools[0].description, /优先.*search_apps.*真实 packageName.*shower.*launch/);
assert.match(tools[1].description, /应用名或包名.*真实 packageName.*shower.*launch/);
const listed = await tools[0].execute("list", {});
assert.deepEqual(JSON.parse(listed.content[0].text), [
  { label:"Settings", packageName:"com.android.settings" },
]);
const searched = await tools[1].execute("search", { query:" CAMERA " });
assert.deepEqual(JSON.parse(searched.content[0].text), [
  { label:"Camera", packageName:"com.android.camera" },
]);
assert.deepEqual(calls, [{ action:"list" }, { action:"search", query:"CAMERA" }]);
await assert.rejects(tools[1].execute("empty", { query:"  " }), /非空关键词/);
assert.equal(calls.length, 2, "empty search does not reach Android");
const aborted = new AbortController();
aborted.abort(new Error("cancelled before native dispatch"));
await assert.rejects(tools[0].execute("abort", {}, aborted.signal), /cancelled before native dispatch/);
assert.equal(calls.length, 2);
const invalid = createAppTools({ request:async () => ({ apps:[] }) });
await assert.rejects(invalid[0].execute("invalid", {}), /响应无效/);
console.log("Android app tools: independent registration, lightweight output, validation, dispatch and cancellation passed");
