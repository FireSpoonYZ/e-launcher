import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "launcher-sdk-check-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
const requests = [], fetchProbes = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url.startsWith("/fetch-probe/")) {
    fetchProbes.push(request.url);
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("fetch-ok");
    return;
  }
  const payload = JSON.parse(body);
  requests.push(payload);
  const last = payload.messages.at(-1), lastContent = JSON.stringify(last?.content);
  const toolName = last?.role === "user" && [
    ["pure tool image", "image_only"], ["mixed tool image", "image_mixed"],
    ["five mib tool image", "image_5m"], ["max tool image", "image_25m"],
    ["oversize tool image", "image_oversize"], ["invalid base64 tool image", "image_invalid"],
  ].find(([prompt]) => lastContent.includes(prompt))?.[1];
  const delta = toolName
    ? { role: "assistant", tool_calls: [{ index: 0, id: `${toolName}-call`, type: "function",
      function: { name: toolName, arguments: "{}" } }] }
    : { role: "assistant", content: "sdk-ok" };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ id:"mock", object:"chat.completion.chunk", choices:[{ index:0, delta, finish_reason:null }] })}\n\ndata: ${JSON.stringify({ id:"mock", object:"chat.completion.chunk", choices:[{ index:0, delta:{}, finish_reason:toolName ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let explicitAgent;
try {
  const { createSdkRuntime, sdkQuery } = await import("./sdk.js");
  const config = { agentDir: join(home, "agent"), cwd: join(home, "workspace"), cacheDir: join(home, "cache"),
    settings: { defaultProvider: "local", defaultModel: "mock", defaultTools: [], compaction: { enabled: false } },
    models: { providers: { local: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
      models: [{ id: "mock", name: "Mock", reasoning: true, input: ["text", "image"] }] } } }, auth: { local: { type: "api_key", key: "mock-only" } } };
  await mkdir(config.cwd, { recursive: true });
  config.chatAttachmentRoot = join(home, "attachments");
  await mkdir(config.chatAttachmentRoot, { recursive: true });
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
    assert.equal(events.find((event) => event.type === "message").message.stopReason, "stop");
    assert.equal(events.at(-1).status, "completed");
    const previousLength = context?.length ?? 0;
    context = events.find((event) => event.type === "context").messages;
    assert.equal(context.length, previousLength + 2, "native history survives subsequent turns");
  }
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const imageId = "11111111-1111-1111-1111-111111111111", fileId = "22222222-2222-2222-2222-222222222222";
  await writeFile(join(config.chatAttachmentRoot, imageId), Buffer.from(imageData, "base64"));
  await writeFile(join(config.chatAttachmentRoot, fileId), "attachment body");
  const attached = await createSdkRuntime({ config, attachments: [
    { id:imageId, path:join(config.chatAttachmentRoot,imageId), name:"photo.png", mimeType:"image/png", kind:"image" },
    { id:fileId, path:join(config.chatAttachmentRoot,fileId), name:"notes.txt", mimeType:"text/plain", kind:"file" },
  ] });
  await attached.prompt("");
  const attachedMessages = requests.at(-1).messages;
  const attachedRequest = JSON.stringify(attachedMessages);
  const userContent = attachedMessages.findLast(message => message.role === "user").content;
  assert(userContent.some(part => part.type === "image_url") && userContent.some(part => part.type === "text" && part.text.includes(fileId)),
    `images use SDK image input and files are exposed as validated readable paths: ${attachedRequest}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(createSdkRuntime({ config, attachments: [{ id:"bad", path:join(home,"outside"), mimeType:"text/plain", kind:"file" }] })
      .then(runtime=>runtime.prompt("bad")), /路径无效/);
    assert.equal((await readdir(config.cacheDir)).filter(name => name.startsWith("pi-request-")).length, 0,
      "invalid attachment releases SDK request services");
  }
  const outside = join(home, "outside-file");
  const linkedId = "33333333-3333-3333-3333-333333333333";
  await writeFile(outside, "outside");
  try {
    await symlink(outside, join(config.chatAttachmentRoot, linkedId));
    await assert.rejects(createSdkRuntime({ config, attachments: [
      { id:linkedId, path:join(config.chatAttachmentRoot,linkedId), mimeType:"text/plain", kind:"file" },
    ] }).then(runtime=>runtime.prompt("linked")), /路径无效/);
    assert.equal((await readdir(config.cacheDir)).filter(name => name.startsWith("pi-request-")).length, 0,
      "symlink rejection releases SDK request services");
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    console.warn("SKIP: OS does not permit creating the attachment symlink fixture");
  }

  const lifecycleFile = join(home, "lifecycle.txt"), extensionFile = join(home, "lifecycle-extension.js");
  const probeUrl = `http://127.0.0.1:${server.address().port}/fetch-probe`;
  await writeFile(extensionFile, `
import { appendFileSync } from "node:fs";
const image = ${JSON.stringify({ type:"image", mimeType:"image/png", data:imageData })};
const sizedImage = (size) => ({ type:"image", mimeType:"image/png", data:Buffer.alloc(size, 0x5a).toString("base64") });
export default function(pi) {
  let widgetText = "before", widgetTui;
  pi.on("session_start", async (_event, ctx) => {
    appendFileSync(${JSON.stringify(lifecycleFile)}, "session_start\\n");
    if (!ctx.hasUI || ctx.mode !== "print") throw new Error("thin UI binding must expose hasUI without claiming TUI mode");
    ctx.ui.setStatus("probe", "ready");
    ctx.ui.notify("extension ready", "info");
    ctx.ui.setWidget("probe", (tui) => {
      widgetTui = tui;
      globalThis.__launcherSdkCheckRender = () => widgetTui.requestRender(true);
      return {
        render:(width) => { appendFileSync(${JSON.stringify(lifecycleFile)}, "widget_render\\n"); return [widgetText + ":" + width]; },
        invalidate:() => {},
        dispose:() => appendFileSync(${JSON.stringify(lifecycleFile)}, "widget_dispose\\n"),
      };
    });
    if (await (await fetch(${JSON.stringify(`${probeUrl}/explicit`)}, { dispatcher: globalThis.__launcherSdkCheckDispatcher })).text() !== "fetch-ok") throw new Error("explicit fetch failed");
    if (await (await fetch(${JSON.stringify(`${probeUrl}/default`)})).text() !== "fetch-ok") throw new Error("default fetch failed");
  });
  pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(lifecycleFile)}, "session_shutdown\\n"));
  pi.on("tool_execution_end", () => { widgetText = "after"; widgetTui?.requestRender(true); });
  pi.registerTool({ name:"image_only", label:"Image only", description:"Return a synthetic image", parameters:{ type:"object", properties:{}, additionalProperties:false },
    execute:async () => ({ content:[image] }) });
  pi.registerTool({ name:"image_mixed", label:"Mixed image", description:"Return text and a synthetic image", parameters:{ type:"object", properties:{}, additionalProperties:false },
    execute:async () => ({ content:[{ type:"text", text:"tool caption" }, image] }) });
  for (const [name, size] of [["image_5m", 5 * 1024 * 1024], ["image_25m", 25 * 1024 * 1024], ["image_oversize", 25 * 1024 * 1024 + 1]])
    pi.registerTool({ name, label:name, description:"Return a sized synthetic image", parameters:{ type:"object", properties:{}, additionalProperties:false },
      execute:async () => ({ content:[sizedImage(size)] }) });
  pi.registerTool({ name:"image_invalid", label:"Invalid image", description:"Return invalid base64", parameters:{ type:"object", properties:{}, additionalProperties:false },
    execute:async () => ({ content:[{ type:"image", mimeType:"image/png", data:"AAAA!" }] }) });
}
`);
  const undici = await import("./node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js");
  explicitAgent = new undici.Agent();
  let explicitDispatches = 0;
  globalThis.__launcherSdkCheckDispatcher = { dispatch(options, handler) {
    explicitDispatches++;
    return explicitAgent.dispatch(options, handler);
  } };
  config.settings.extensions = [extensionFile];
  const lifecycleLines = async () => {
    try { return (await readFile(lifecycleFile, "utf8")).trim().split("\n"); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  };
  const lifecycleCounts = async () => {
    const lines = await lifecycleLines();
    return { starts:lines.filter(line => line === "session_start").length,
      shutdowns:lines.filter(line => line === "session_shutdown").length };
  };
  for (const [prompt, expectedText] of [["pure tool image", ""], ["mixed tool image", "tool caption"]]) {
    const before = await lifecycleCounts();
    const runtime = await createSdkRuntime({ config });
    const started = await lifecycleCounts();
    assert.deepEqual(started, { starts:before.starts + 1, shutdowns:before.shutdowns },
      "bindExtensions sends session_start once before prompting");
    const events = [];
    runtime.subscribe((event) => events.push(event));
    assert.deepEqual(events[0].state.widgets[0].lines, ["before:80"], "UI created before subscribe is replayed");
    assert.deepEqual(events[0].state.statuses, [{ key:"probe", text:"ready" }]);
    assert.equal(events[0].state.notifications[0].message, "extension ready");
    await runtime.prompt(prompt);
    assert(events.some((event) => event.type === "extension_ui" && event.state.widgets[0]?.lines[0] === "after:80"),
      "factory requestRender publishes a fresh snapshot");
    const ended = await lifecycleCounts();
    assert.deepEqual(ended, { starts:before.starts + 1, shutdowns:before.shutdowns + 1 },
      "native runtime disposal sends session_shutdown once");
    const rendersAfterDispose = (await lifecycleLines()).filter(line => line === "widget_render").length;
    globalThis.__launcherSdkCheckRender();
    assert.equal((await lifecycleLines()).filter(line => line === "widget_render").length, rendersAfterDispose,
      "requestRender cannot call a factory after runtime disposal");
    const toolMessage = events.find((event) => event.type === "message" && event.message.role === "tool").message;
    assert.equal(toolMessage.content, expectedText);
    assert.equal(toolMessage.attachments.length, 1, "tool images are projected as one chat attachment");
    assert.equal(toolMessage.attachments[0].mimeType, "image/png");
    assert.equal(toolMessage.attachments[0].path, join(config.chatAttachmentRoot, toolMessage.attachments[0].id));
    assert.deepEqual(await readFile(toolMessage.attachments[0].path), Buffer.from(imageData, "base64"));
    assert(!JSON.stringify(toolMessage).includes(imageData), "chat projection never exposes base64 as text or metadata");
    assert(events.find((event) => event.type === "tool_end").result.content.some((part) => part.type === "image"));
    const snapshot = events.find((event) => event.type === "context");
    assert(snapshot.entries.some((entry) => entry.message?.role === "toolResult"
      && entry.message.content.some((part) => part.type === "image")), "native model history retains tool images");
    assert(JSON.stringify(requests.at(-1).messages).includes("data:image/png;base64,"),
      "tool images remain in the model's follow-up request");
  }
  for (const [prompt, bytes] of [["five mib tool image", 5 * 1024 * 1024], ["max tool image", 25 * 1024 * 1024]]) {
    const before = await lifecycleCounts();
    const runtime = await createSdkRuntime({ config });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.prompt(prompt);
    assert.equal(events.at(-1).status, "completed", `${bytes} byte tool image completes its turn`);
    const toolMessage = events.find((event) => event.type === "message" && event.message.role === "tool").message;
    assert.equal(toolMessage.attachments[0].size, bytes);
    assert((await readFile(toolMessage.attachments[0].path)).equals(Buffer.alloc(bytes, 0x5a)),
      `${bytes} byte tool image is written without corruption`);
    const ended = await lifecycleCounts();
    assert.deepEqual(ended, { starts:before.starts + 1, shutdowns:before.shutdowns + 1 },
      `${bytes} byte successful turn closes the extension session exactly once`);
    assert.equal((await readdir(config.cacheDir)).filter(name => name.startsWith("pi-request-")).length, 0);
    requests.length = 0;
  }
  for (const [prompt, expectedError] of [["oversize tool image", /工具图片大小无效/], ["invalid base64 tool image", /工具图片数据无效/]]) {
    const before = await lifecycleCounts();
    const runtime = await createSdkRuntime({ config });
    const events = [];
    runtime.subscribe((event) => events.push(event));
    await assert.rejects(runtime.prompt(prompt), expectedError);
    assert(!events.some((event) => event.type === "message" && event.message.role === "tool"),
      `${prompt} does not publish an invalid attachment`);
    assert(events.some((event) => event.type === "context"), `${prompt} still publishes native context on failure`);
    const ended = await lifecycleCounts();
    assert.deepEqual(ended, { starts:before.starts + 1, shutdowns:before.shutdowns + 1 },
      `${prompt} failure closes the extension session exactly once`);
    assert.equal((await readdir(config.cacheDir)).filter(name => name.startsWith("pi-request-")).length, 0);
    requests.length = 0;
  }
  console.log("PASS: 5 MiB and 25 MiB tool images persisted; oversize and invalid base64 rejected with lifecycle cleanup");
  for (const failure of ["attachment", "abort"]) {
    const before = await lifecycleCounts();
    const controller = new AbortController();
    const runtime = await createSdkRuntime({ config, attachments: failure === "attachment"
      ? [{ id:"bad", path:join(home, "outside"), mimeType:"text/plain", kind:"file" }] : undefined }, controller.signal);
    if (failure === "abort") controller.abort();
    await assert.rejects(runtime.prompt("fail before send"), failure === "attachment" ? /路径无效/ : { name:"AbortError" });
    const ended = await lifecycleCounts();
    assert.deepEqual(ended, { starts:before.starts + 1, shutdowns:before.shutdowns + 1 },
      `${failure} cleanup closes the started extension session exactly once`);
    assert.equal((await readdir(config.cacheDir)).filter(name => name.startsWith("pi-request-")).length, 0);
  }
  assert.equal(explicitDispatches, 8, "an explicit caller dispatcher receives each extension request");
  assert.equal(fetchProbes.filter((path) => path === "/fetch-probe/explicit").length, 8);
  assert.equal(fetchProbes.filter((path) => path === "/fetch-probe/default").length, 8,
    "requests without an explicit dispatcher still use the session transport");
  const lifecycleTotals = await lifecycleLines();
  assert.equal(lifecycleTotals.filter(line => line === "widget_dispose").length,
    lifecycleTotals.filter(line => line === "session_start").length,
    "every factory is disposed once across successful, rejected, and aborted turns");
  delete config.settings.extensions;
  delete globalThis.__launcherSdkCheckDispatcher;
  delete globalThis.__launcherSdkCheckRender;

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
  delete globalThis.__launcherSdkCheckDispatcher;
  await explicitAgent?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
