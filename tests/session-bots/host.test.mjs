import test from "node:test";
import assert from "node:assert/strict";
import { SessionBotHost } from "../../pi-runtime/session-bots/host.mjs";
import { Fixture, aRoutine } from "./fixture.mjs";

/** Test storage only. It models atomic CAS; it is not Android persistence. */
class Store {
  fail = false; writes = 0;
  constructor(state) { this.state = structuredClone(state); }
  async load() { return structuredClone(this.state); }
  async compareAndSwap(revision, next) {
    if (this.fail) throw new Error("disk full");
    if (this.state.revision !== revision) throw new Error("CAS conflict");
    this.state = JSON.parse(JSON.stringify(next)); this.writes++;
  }
}
function prepared() {
  const f = new Fixture(), run = f.start();
  f.state.outbox = []; const store = new Store(f.state);
  const host = new SessionBotHost({ store, now: () => f.clock++, id: f.id });
  const cap = { runId: run.id, token: run.token };
  const send = (callId = "call-1", body = "hello") => host.dispatchTool(cap, { name: "bots_send", args: { toSessionId: "B", body }, callId });
  return { f, run, store, host, cap, send };
}
test("failed durable commit has no state mutation and no native effects", async () => {
  const { store, host, send } = prepared(), before = structuredClone(store.state); store.fail = true;
  await assert.rejects(send, /disk full/); assert.deepEqual(store.state, before);
  let dispatched = 0; await host.flush({ dispatch: async () => { dispatched++; }, canWake: true });
  assert.equal(dispatched, 0);
});
test("concurrent duplicate tool calls serialize to a single message", async () => {
  const { store, send } = prepared(); const replies = await Promise.all(Array.from({ length: 20 }, () => send()));
  assert.ok(replies.every(r => r.messageId === replies[0].messageId));
  assert.equal(Object.values(store.state.deliveries).filter(d => d.envelope.origin.kind === "bot").length, 1);
  assert.equal(store.writes, 1);
});
test("a rejected command does not poison the host serial queue", async () => {
  const { host, cap, send } = prepared();
  await assert.rejects(() => host.dispatchTool(cap, { name: "bots_delete", args: {}, callId: "bad" }));
  assert.equal((await send()).status, "queued");
});
test("outbox is durable before effect execution and can be drained after reconstruction", async () => {
  const { store, send, f } = prepared(); await send(); const persisted = JSON.parse(JSON.stringify(store.state));
  const restored = new SessionBotHost({ store: new Store(persisted), id: f.id }); const dispatched = [];
  await restored.flush({ dispatch: async e => { dispatched.push(e.kind); }, canWake: true });
  assert.deepEqual(dispatched, ["publishDelivery", "wakeSession"]); assert.equal((await restored.snapshot()).outbox.length, 0);
});
test("wake gate retains pending wakes without blocking non-wake effects", async () => {
  const { host, send } = prepared(); await send(); const dispatched = [];
  await host.flush({ dispatch: async e => dispatched.push(e.kind), canWake: false });
  assert.deepEqual(dispatched, ["publishDelivery"]); assert.equal((await host.snapshot()).outbox[0].kind, "wakeSession");
});
test("native dispatch failure retains the effect ID for idempotent retry", async () => {
  const { host, send } = prepared(); await send(); const id = (await host.snapshot()).outbox[0].id;
  await assert.rejects(() => host.flush({ dispatch: async () => { throw new Error("native unavailable"); }, canWake: true }));
  assert.equal((await host.snapshot()).outbox[0].id, id);
});
test("acknowledgement failure can redeliver an effect: consumer deduplicates by ID", async () => {
  const { host, store, send } = prepared(); await send();
  const performed = new Set(); let sideEffects = 0;
  const dispatch = async e => { if (!performed.has(e.id)) { performed.add(e.id); sideEffects++; } store.fail = true; };
  await assert.rejects(() => host.flush({ dispatch, canWake: false }), /disk full/);
  assert.equal(sideEffects, 1); store.fail = false;
  await host.flush({ dispatch: async e => { if (!performed.has(e.id)) { performed.add(e.id); sideEffects++; } }, canWake: false });
  assert.equal(sideEffects, 1);
});
test("wake handler may claim a run through the same host without deadlock", { timeout: 2000 }, async () => {
  const { host, send } = prepared(); await send(); let claimed;
  await host.flush({ canWake: true, dispatch: async e => {
    if (e.kind === "wakeSession") claimed = await host.dispatchHost({ type: "claimNext", sessionId: e.payload.sessionId, processId: "p1" });
  } });
  assert.equal(claimed.run.sessionId, "B");
});
test("archive before outbox dispatch prevents a stale wake", async () => {
  const { host, send } = prepared(); await send(); await host.dispatchHost({ type: "archiveSession", sessionId: "B" });
  const dispatched = [];
  await host.flush({ dispatch: async e => { dispatched.push(e.kind); }, canWake: true });
  assert.ok(!dispatched.includes("wakeSession"));
});
test("native deletion is deferred until in-flight termination is acknowledged", async () => {
  const { host, run } = prepared(); await host.dispatchHost({ type: "deleteSession", sessionId: "A" });
  const dispatched = [];
  const dispatch = async e => { dispatched.push(e.kind); };
  await host.flush({ dispatch }); assert.ok(dispatched.includes("cancelRun"));
  assert.ok(!dispatched.includes("deleteSessionAfterTermination"));
  await host.dispatchHost({ type: "completeRun", runId: run.id, token: run.token, status: "aborted" });
  await host.flush({ dispatch }); assert.ok(dispatched.includes("deleteSessionAfterTermination"));
});
test("configuration effects carry revisions; old schedules are not reinstated", async () => {
  const { host, cap } = prepared();
  const r = await host.dispatchTool(cap, { name: "bot_routine_save", args: aRoutine(), callId: "c1" });
  await host.dispatchTool(cap, { name: "bot_routine_set_enabled", args: { id: r.id, revision: 1, enabled: false }, callId: "c2" });
  const revisions = [];
  await host.flush({ dispatch: async e => { if (e.kind === "rescheduleRoutine") revisions.push(e.payload.revision); } });
  assert.deepEqual(revisions, [2]);
});
