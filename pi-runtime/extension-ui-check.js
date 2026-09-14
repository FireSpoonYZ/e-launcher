import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExtensionUiBridge,
  findRpivTodoTool,
  readTodoSnapshot,
  replayRpivTodo,
} from "./extension-ui.js";

const root = await mkdtemp(join(tmpdir(), "launcher-extension-ui-"));
try {
  const packageRoot = join(root, "node_modules", "@juicesharp", "rpiv-todo");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@juicesharp/rpiv-todo", version: "2.10.1" }));
  await writeFile(join(packageRoot, "index.ts"), "export default function() {}\n");
  const sourceInfo = { source: "npm:@juicesharp/rpiv-todo", origin: "package", scope: "user",
    baseDir: packageRoot, path: join(packageRoot, "index.ts") };
  const recognized = await findRpivTodoTool([{ name: "todo", sourceInfo }]);
  assert.equal(recognized?.name, "todo", "the package-owned todo tool is recognized");
  assert.equal(await findRpivTodoTool([{ name: "todo", sourceInfo: { ...sourceInfo, source: "./same-name.js" } }]), undefined,
    "a same-name tool without the package source is rejected");
  assert.equal(await findRpivTodoTool([{ name: "todo", sourceInfo: { ...sourceInfo, baseDir: root } }]), undefined,
    "the package manifest and canonical extension path are part of identity verification");

  const first = { tasks: [{ id:1, subject:"first", status:"in_progress" }], nextId:2 };
  const later = { tasks: [{ id:1, subject:"first", status:"completed" },
    { id:2, subject:"second", status:"pending" }], nextId:3 };
  const owned = (snapshot) => ({ package:"@juicesharp/rpiv-todo", ...snapshot });
  assert.deepEqual(readTodoSnapshot(first), owned(first), "validated snapshots carry their verified package identity");
  assert.equal(readTodoSnapshot({ tasks:[{ id:1, subject:"bad", status:"unknown" }], nextId:2 }), undefined);
  assert.deepEqual(replayRpivTodo([
    { type:"message", message:{ role:"toolResult", toolName:"todo", details:first } },
    { type:"message", message:{ role:"toolResult", toolName:"other", details:later } },
    { type:"message", message:{ role:"toolResult", toolName:"todo", details:later } },
    { type:"message", message:{ role:"toolResult", toolName:"todo", details:{ tasks:"corrupt", nextId:9 } } },
  ], recognized), owned(later), "the last valid package todo snapshot wins even when followed by corrupt data");
  assert.deepEqual(replayRpivTodo([], recognized), owned({ tasks:[], nextId:1 }),
    "recognized package replay starts with an explicitly owned empty snapshot");
  assert.equal(replayRpivTodo([{ type:"message", message:{ role:"toolResult", toolName:"todo", details:first } }], undefined), null,
    "history is not guessed from an unconfirmed tool name");

  let rendered = "one", tui, residualTui, invalidations = 0, disposals = 0, residualRenders = 0, residualDisposals = 0;
  const bridge = new ExtensionUiBridge({ width:80, theme:{}, ignoredWidgetKeys:new Set(["ignored"]) });
  bridge.ui.setWidget("factory", (nextTui) => {
    tui = nextTui;
    return {
      render: (width) => [`${rendered}:${width}`],
      invalidate: () => { invalidations++; },
      dispose: () => { disposals++; },
    };
  }, { placement:"belowEditor" });
  bridge.ui.setWidget("ignored", () => { throw new Error("ignored factories must not be rendered"); });
  bridge.ui.setWidget("residual", (nextTui) => {
    residualTui = nextTui;
    return {
      render: () => { residualRenders++; return ["residual"]; },
      dispose: () => { residualDisposals++; },
    };
  });
  bridge.ui.setWidget("strings", ["alpha", "beta"]);
  bridge.ui.setWidget("single", "one line");
  bridge.ui.setStatus("work", "Working");
  bridge.ui.notify("Saved", "info");
  const snapshots = [];
  bridge.subscribe((snapshot) => snapshots.push(snapshot));
  assert.deepEqual(snapshots[0].widgets.map((widget) => widget.key), ["factory", "residual", "strings", "single"],
    "subscribers receive widgets created before they bind");
  assert.deepEqual(snapshots[0].statuses, [{ key:"work", text:"Working" }]);
  assert.equal(snapshots[0].notifications.length, 1, "only the bounded latest notification is retained");
  assert.deepEqual(snapshots[0].widgets[0], { key:"factory", placement:"belowEditor", lines:["one:80"] });
  rendered = "two";
  tui.requestRender(true);
  assert.equal(invalidations, 1);
  assert.deepEqual(snapshots.at(-1).widgets[0].lines, ["two:80"], "factory requestRender publishes fresh lines");
  bridge.ui.setWidget("factory", undefined);
  assert.equal(disposals, 1, "removing a factory widget disposes its component");
  assert(!snapshots.at(-1).widgets.some((widget) => widget.key === "factory"));
  const countBeforeTeardown = snapshots.length;
  bridge.suspend();
  bridge.ui.setWidget("strings", undefined);
  bridge.ui.setWidget("single", undefined);
  bridge.ui.setStatus("work", undefined);
  assert.equal(snapshots.length, countBeforeTeardown, "session teardown cannot publish a clearing snapshot");
  bridge.dispose();
  bridge.dispose();
  assert.equal(residualDisposals, 1, "runtime disposal releases every remaining factory component exactly once");
  const rendersAfterDispose = residualRenders;
  residualTui.requestRender(true);
  bridge.ui.setWidget("late", () => { throw new Error("destroyed bridges must not create components"); });
  bridge.ui.notify("late");
  assert.equal(residualRenders, rendersAfterDispose, "requestRender does not render after bridge disposal");
  assert.equal(snapshots.length, countBeforeTeardown, "bridge disposal retains the host's last published snapshot");

  console.log("PASS: extension UI bridge, disposal, package identity, structured snapshots and replay");
} finally {
  await rm(root, { recursive:true, force:true });
}
