import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fields = JSON.parse(await readFile(new URL("../app/src/main/assets/pi-settings-fields.json", import.meta.url), "utf8"));
const documentation = await readFile(new URL("node_modules/@earendil-works/pi-coding-agent/docs/settings.md", import.meta.url), "utf8");
const documented = [...documentation.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(?:string|boolean|number|object|array)/gm)].map((match) => match[1]);
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
console.log(`PASS: all ${keys.length} Pi and bundled extension settings have labeled, grouped controls`);
