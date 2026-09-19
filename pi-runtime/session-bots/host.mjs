import { applyHost, applyTool } from "./core.mjs";

/**
 * Storage contract:
 *   load(): Promise<State>
 *   compareAndSwap(expectedRevision, nextState): Promise<void>
 * CAS must atomically persist the complete state, including receipts + outbox,
 * or throw without committing anything. The native adapter must reuse existing
 * ChatStore session IDs and gate all calls by authenticated request ownership.
 */
export class SessionBotHost {
  #store; #clock; #ids; #tail = Promise.resolve(); #flushing;
  constructor({ store, now = Date.now, id }) { this.#store = store; this.#clock = now; this.#ids = id; }
  #serialize(work) {
    const next = this.#tail.then(work);
    this.#tail = next.catch(() => {});
    return next;
  }
  #change(transition) {
    return this.#serialize(async () => {
      const before = await this.#store.load();
      const { state, result } = transition(before, { now: this.#clock(), ...(this.#ids ? { id: this.#ids } : {}) });
      if (state !== before) await this.#store.compareAndSwap(before.revision, state);
      return result;
    });
  }
  dispatchHost(command) { return this.#change((s, e) => applyHost(s, command, e)); }
  dispatchTool(capability, invocation) { return this.#change((s, e) => applyTool(s, capability, invocation, e)); }
  snapshot() { return this.#serialize(async () => structuredClone(await this.#store.load())); }

  /**
   * Native dispatch MUST be idempotent by effect.id. A crash after the side effect
   * but before acknowledgement can redeliver it. This is NOT exactly-once execution.
   * Do not call this until the Android host is allowed to start background work.
   * The canWake=false mode still drains cancellation and UI updates, but retains wakes.
   */
  flush({ dispatch, canWake = false, maxEffects = 100 }) {
    if (this.#flushing) return this.#flushing;
    if (!Number.isSafeInteger(maxEffects) || maxEffects < 1) return Promise.reject(new Error("Invalid maxEffects"));
    const task = this.#flush(dispatch, canWake, maxEffects);
    this.#flushing = task;
    task.finally(() => { if (this.#flushing === task) this.#flushing = undefined; }).catch(() => {});
    return task;
  }
  async #flush(dispatch, canWake, maxEffects) {
    let count = 0;
    const deferred = new Set();
    while (count < maxEffects) {
      const state = await this.snapshot();
      const entry = state.outbox.find(e => !deferred.has(e.id));
      if (!entry) break;
      const { kind, payload: p } = entry;
      const owner = p.sessionId ? state.sessions[p.sessionId] : null;
      let obsolete = false;
      if (["wakeSession", "createSession", "publishProfile"].includes(kind)) obsolete = !owner || owner.deleted;
      if (kind === "wakeSession") {
        obsolete ||= owner?.archived || !Object.values(state.deliveries).some(d => d.envelope.toSessionId === p.sessionId && d.status === "queued");
        if (!obsolete && !canWake) { deferred.add(entry.id); continue; }
      }
      if (kind === "rescheduleRoutine") {
        const r = state.routines[p.routineId];
        obsolete = !r || r.revision !== p.revision || state.sessions[r.ownerSessionId]?.deleted || state.sessions[r.ownerSessionId]?.archived;
      }
      if (kind === "cancelRun") {
        const run = state.runs[p.runId];
        obsolete = !run || run.status !== "running" || run.token !== p.token || !run.cancelRequested;
      }
      if (kind === "deleteSessionAfterTermination"
          && Object.values(state.runs).some(r => r.sessionId === p.sessionId && r.status === "running")) {
        deferred.add(entry.id); continue;
      }
      // Never hold the command serialization lock across an external effect.
      // The native consumer must REVALIDATE ownership/revision inside its own transaction:
      // a delete/archive/role change can race between this snapshot and dispatch.
      if (!obsolete) await dispatch(structuredClone(entry), state);
      await this.dispatchHost({ type: "ackEffect", effectId: entry.id });
      count++;
    }
    return { acknowledged: count };
  }
}
