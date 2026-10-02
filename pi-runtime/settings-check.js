import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
  const pinned = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8")).dependencies[`@earendil-works/${name}`];
  const installed = JSON.parse(await readFile(new URL(`node_modules/@earendil-works/${name}/package.json`, import.meta.url), "utf8")).version;
  assert.equal(pinned, "1.0.0", `${name} must be exactly pinned`);
  assert.equal(installed, pinned, `${name} installed version`);
}

const fields = JSON.parse(await readFile(new URL("../app/src/main/assets/pi-settings-fields.json", import.meta.url), "utf8"));
const documentation = await readFile(new URL("node_modules/@earendil-works/pi-coding-agent/docs/settings.md", import.meta.url), "utf8");
const documented = [...documentation.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]);
const keys = fields.map((field) => field.key);
assert.equal(new Set(keys).size, keys.length, "no duplicate setting controls");
assert.deepEqual(fields.filter((field) => !field.extension).map((field) => field.key).sort(),
  [...new Set(documented)].sort(), "every documented settings.json option has a form entry");
assert.deepEqual(fields.filter((field) => field.extension).map((field) => [field.extension, field.key]),
  [["conversation-title", "conversationTitle.model"]], "bundled extension settings are explicitly identified");
for (const field of fields) {
  assert(field.label && field.group && field.type && field.description, `complete metadata: ${field.key}`);
  if (field.options) assert(new Set(field.options).size === field.options.length && field.options.length > 1);
}
const quietStartup = fields.find(field => field.key === "quietStartup");
assert.equal(quietStartup.type, 'boolean or "header"');
assert.deepEqual(quietStartup.options, [false, true, "header"]);
assert.equal(JSON.parse(quietStartup.default), false);
const tuiMode = fields.find(field => field.key === "tuiMode");
assert.equal(JSON.parse(tuiMode.default), "fullscreen");
assert(!tuiMode.description.includes("experimental"));
const translations = JSON.parse(await readFile(new URL("../app/src/main/assets/ui-en.json", import.meta.url), "utf8"));
const activity = await readFile(new URL("../app/src/main/java/com/example/launcherprobe/PiSettingsActivity.java", import.meta.url), "utf8");
assert(!activity.includes("Pi 配置格式 0.99.2") && !activity.includes("Pi Coding Agent SDK 0.99.2"));
for (const [key, value] of Object.entries(translations)) {
  if (key.includes("Pi ") && key.includes("1.0.0")) assert(value.includes("1.0.0"), `matching translated version: ${key}`);
  assert(!key.includes("Pi Coding Agent SDK 0.99.2") && !key.includes("Pi 配置格式 0.99.2"));
}
for (const key of [
  "Pi Coding Agent SDK 1.0.0 · 本地 Node Agent",
  "Pi 配置格式 1.0.0。Pi Agent 使用完整 SDK 读取设置和资源。终端专用选项保留在文件中，不改变 Android 界面。",
]) assert(activity.includes(key) && translations[key]?.includes("1.0.0"), "settings version text and translation key match");
console.log(`PASS: all ${keys.length} Pi and bundled extension settings have labeled, grouped controls`);
