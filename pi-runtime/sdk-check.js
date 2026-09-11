import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "launcher-sdk-check-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end('data: {"id":"mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"sdk-ok"},"finish_reason":null}]}\n\ndata: {"id":"mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { createSdkRuntime, sdkQuery } = await import("./sdk.js");
  const config = { agentDir: join(home, "agent"), cwd: join(home, "workspace"), cacheDir: join(home, "cache"),
    settings: { defaultProvider: "local", defaultModel: "mock", defaultTools: [], compaction: { enabled: false } },
    models: { providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
      models: [{ id: "mock", name: "Mock", reasoning: true }] } } }, auth: { local: { type: "api_key", key: "mock-only" } } };
  await mkdir(config.cwd, { recursive: true });
  const catalog = await sdkQuery({ type: "catalog", config });
  assert.equal(catalog.find((provider) => provider.id === "local").models[0].id, "mock");
  assert(catalog.find((provider) => provider.id === "local").models[0].thinkingLevels.includes("high"));
  let context;
  for (const level of ["low", "medium", "high"]) {
    config.settings.defaultThinkingLevel = level;
    const runtime = await createSdkRuntime({ config, sdkHistory: context });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.prompt("hello");
    assert.equal(requests.at(-1).reasoning_effort, level);
    assert.equal(events.find((event) => event.type === "message").message.content, "sdk-ok");
    assert.equal(events.at(-1).status, "completed");
    const previousLength = context?.length ?? 0;
    context = events.find((event) => event.type === "context").messages;
    assert.equal(context.length, previousLength + 2, "native history survives subsequent turns");
  }
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const saved = SessionManager.inMemory(config.cwd);
  saved.appendMessage({ role: "user", content: "discard-old", timestamp: 1 });
  const kept = saved.appendMessage({ role: "user", content: "keep-recent", timestamp: 2 });
  saved.appendCompaction("saved-summary", kept, 30000);
  const compacted = await createSdkRuntime({ config, sdkHistory: [saved.getHeader(), ...saved.getEntries()],
    sdkHistoryTail: [{ role: "user", content: "tail-after-snapshot" }] });
  await compacted.prompt("after-compaction");
  const restoredRequest = JSON.stringify(requests.at(-1).messages);
  assert(restoredRequest.includes("saved-summary") && restoredRequest.includes("keep-recent") && restoredRequest.includes("tail-after-snapshot"));
  assert(!restoredRequest.includes("discard-old"), "native compaction entries retain the cut point on restoration");
  config.selection = { provider: "local", model: "mock", thinkingLevel: "low" };
  const selected = await createSdkRuntime({ config });
  await selected.prompt("session-only selection");
  assert.equal(requests.at(-1).reasoning_effort, "low");
  assert.equal(config.settings.defaultThinkingLevel, "high", "session selection never writes startup defaults");
  delete config.selection;
  const cancelled = new AbortController();
  const failing = await createSdkRuntime({ config }, cancelled.signal);
  const failureEvents = [];
  failing.subscribe((event) => failureEvents.push(event));
  const sentBeforeFailure = requests.length;
  cancelled.abort();
  await assert.rejects(failing.prompt("cancelled before send"), { name: "AbortError" });
  assert.equal(requests.length, sentBeforeFailure, "pre-send failure makes no provider request");
  assert.equal(failureEvents.find((event) => event.type === "context").entries[0].type, "session",
    "a throwing prompt still publishes native context for the bridge's error end");
  config.globalSettings = { ...config.settings };
  config.projectSettings = { skills: ["./selected-skills"] };
  const skillDir = join(config.cwd, ".pi", "selected-skills", "project-check");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: project-check\ndescription: Workspace-relative loading check\n---\nLocal fixture.\n");
  config.models.providers.local.models[0].reasoning = false;
  await assert.rejects(createSdkRuntime({ config }), /reasoning/);
  const resources = await sdkQuery({ type: "resources", config });
  assert.ok(resources.skills.skills.some((skill) => skill.name === "project-check"), "project resource paths resolve relative to project scope");
  const apply = (event) => {
    if (event.type === "setting") config[event.project ? "projectSettings" : "globalSettings"][event.key] = event.value;
  };
  const paths = await sdkQuery({ type: "resource_paths", config });
  const path = paths.skills.find((item) => item.path.includes("selected-skills")).path;
  await sdkQuery({ type: "resource_toggle", config, kind: "skills", path, enabled: false }, undefined, apply);
  assert(!(await sdkQuery({ type: "resources", config })).skills.skills.some((skill) => skill.name === "project-check"));
  await sdkQuery({ type: "resource_toggle", config, kind: "skills", path, enabled: null }, undefined, apply);
  assert((await sdkQuery({ type: "resources", config })).skills.skills.some((skill) => skill.name === "project-check"));
  const explicit = join(config.agentDir, "custom", "probe.ts");
  await mkdir(join(config.agentDir, "custom"), { recursive: true });
  await writeFile(explicit, "export default function() {}\n");
  config.globalSettings.extensions = ["custom/probe.ts"];
  for (const enabled of [true, false, null]) {
    await sdkQuery({ type: "resource_toggle", config, kind: "extensions", path: explicit, enabled }, undefined, apply);
    assert(config.globalSettings.extensions.includes("custom/probe.ts"), "explicit discovery source is preserved");
    const current = (await sdkQuery({ type: "resource_paths", config })).extensions.find((item) => item.path === explicit);
    assert(current, "explicit extension stays discoverable after toggling");
    assert.equal(current.enabled, enabled !== false);
  }
  const packageDir = join(home, "fixture-package");
  await mkdir(join(packageDir, "skills"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-package", pi: { skills: ["skills"] } }));
  const skillFile = join(packageDir, "skills", "SKILL.md");
  await writeFile(skillFile, "---\nname: fixture-package\ndescription: Local package check\n---\nFixture.\n");
  await sdkQuery({ type: "install", config, source: packageDir }, undefined, apply);
  assert((await sdkQuery({ type: "packages", config })).some((pkg) => pkg.installedPath === packageDir || pkg.source === packageDir));
  await sdkQuery({ type: "remove", config, source: packageDir }, undefined, apply);
  assert.equal((await sdkQuery({ type: "packages", config })).length, 0);
  assert((await readFile(skillFile, "utf8")).includes("Fixture."), "removing a local package preserves its source files");
  console.log("Full SDK: registry, scoped resources/toggles, package lifecycle, thinking, session selection and native compaction restoration passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
