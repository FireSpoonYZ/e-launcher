import { randomUUID } from "node:crypto";
import { LIMITS, fail, object, text, identifier, integer, bool,
  validateEnvelope, projectMessage, composeRolePrompt, renderWakePrompt } from "./protocol.mjs";

/**
 * Pure, transactional domain transitions. The Android host must commit state +
 * outbox atomically and execute outbox entries idempotently. This module does
 * not run JS timers, create Pi histories, or maintain a separate Bot identity.
 * sessions contains metadata keyed by the existing ChatStore session IDs.
 */
export function emptyState() {
  return { version: 1, sessions: {}, routines: {}, deliveries: {}, runs: {}, receipts: {},
    chains: {}, outbox: [], revision: 0 };
}
function keyed(map, id) { return Object.hasOwn(map, id) ? map[id] : undefined; }
function session(s, id, allowArchived = false) {
  identifier(id, "sessionId");
  const item = keyed(s.sessions, id);
  if (!item || item.deleted) fail("not_found", "Session does not exist");
  if (item.archived && !allowArchived) fail("archived", "Restore the session first");
  return item;
}
function routine(s, id, owner) {
  identifier(id, "routineId");
  const item = keyed(s.routines, id);
  if (!item || item.ownerSessionId !== owner) fail("not_found", "Routine not found in this session");
  return item;
}
function revision(actual, expected) {
  integer(expected, "revision", 1);
  if (actual !== expected) fail("conflict", "Configuration changed; read the current revision before editing");
}
function checkedId(env) {
  const id = identifier(env.id());
  // IDs from the host generator must not overwrite any existing object/prototype key.
  if (["__proto__", "prototype", "constructor"].includes(id)) fail("invalid", "Unsafe generated ID");
  return id;
}
function alloc(s, env) {
  const id = checkedId(env);
  if ([s.sessions, s.routines, s.deliveries, s.runs, s.receipts, s.chains].some(m => keyed(m, id))
      || s.outbox.some(e => e.id === id)) fail("conflict", "Host generated a duplicate ID");
  return id;
}
function effect(s, env, kind, payload) {
  s.outbox.push({ id: alloc(s, env), kind, payload: structuredClone(payload) });
}
function resultState(s, result) { s.revision++; return { state: s, result: structuredClone(result) }; }
function copy(input, options) {
  if (input.version !== 1) fail("invalid", "Unsupported state version");
  const env = { now: options?.now ?? Date.now(), id: options?.id ?? randomUUID };
  integer(env.now, "now");
  return [structuredClone(input), env];
}
function runFor(s, capability) {
  object(capability, ["runId", "token"], ["runId", "token"]);
  const run = keyed(s.runs, identifier(capability.runId));
  if (!run || run.token !== capability.token || run.status !== "running" || run.cancelRequested)
    fail("stale_run", "This run is no longer allowed to perform tool effects");
  session(s, run.sessionId);
  return run;
}
function modelSelection(value) {
  object(value, ["provider", "model", "thinkingLevel"], ["provider", "model"]);
  text(value.provider, "provider", 128); text(value.model, "model", 256);
  if (value.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel))
    fail("invalid", "Invalid thinkingLevel");
  return structuredClone(value);
}
function profileInput(input) {
  text(input.name, "name", LIMITS.name);
  text(input.rolePrompt ?? "", "rolePrompt", LIMITS.rolePrompt, true);
  text(input.description ?? "", "description", 500, true);
  return { name: input.name.trim(), description: input.description ?? "", rolePrompt: input.rolePrompt ?? "" };
}
/** Calendar calculation belongs to the native scheduler. This validates its wire contract only. */
export function validateSchedule(value) {
  object(value, ["kind", "timeZone", "hour", "minute", "weekdays", "day", "intervalMinutes", "cron"], ["kind", "timeZone"]);
  text(value.timeZone, "timeZone", 100);
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); }
  catch { fail("invalid", "Unknown time zone"); }
  const variants = {
    daily: ["hour", "minute"], weekly: ["hour", "minute", "weekdays"],
    monthly: ["hour", "minute", "day"], interval: ["intervalMinutes"], cron: ["cron"],
  };
  const permitted = Object.hasOwn(variants, value.kind) ? variants[value.kind] : undefined;
  if (!permitted) fail("invalid", "Unsupported schedule kind");
  for (const key of Object.keys(value)) if (!["kind", "timeZone", ...permitted].includes(key))
    fail("invalid", `Field ${key} does not belong to ${value.kind}`);
  for (const key of permitted) if (!Object.hasOwn(value, key)) fail("invalid", `Missing schedule field ${key}`);
  if (permitted.includes("hour")) {
    integer(value.hour, "hour"); integer(value.minute, "minute");
    if (value.hour > 23 || value.minute > 59) fail("invalid", "Invalid local time");
  }
  if (value.kind === "weekly") {
    if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7
        || new Set(value.weekdays).size !== value.weekdays.length) fail("invalid", "Invalid weekdays");
    for (const day of value.weekdays) { integer(day, "weekday", 1); if (day > 7) fail("invalid", "Invalid weekday"); }
  }
  if (value.kind === "monthly") { integer(value.day, "day", 1); if (value.day > 31) fail("invalid", "Invalid day"); }
  if (value.kind === "interval") integer(value.intervalMinutes, "intervalMinutes", 1);
  // The host must compile cron with its chosen calendar library BEFORE committing this transition.
  // A raw cron string is not accepted until that library adapter is installed.
  if (value.kind === "cron") fail("unsupported", "Custom cron requires the native calendar adapter");
  return structuredClone(value);
}
function newRoutine(s, owner, input, env) {
  object(input, ["title", "prompt", "schedule", "enabled"], ["title", "prompt", "schedule"]);
  if (Object.values(s.routines).filter(r => r.ownerSessionId === owner).length >= LIMITS.routinesPerSession)
    fail("budget", "Routine limit reached");
  text(input.title, "title", 80); text(input.prompt, "prompt", LIMITS.body);
  const item = { id: alloc(s, env), ownerSessionId: owner, title: input.title.trim(), prompt: input.prompt,
    schedule: validateSchedule(input.schedule), enabled: input.enabled === undefined ? true : bool(input.enabled, "enabled"),
    revision: 1, createdAt: env.now, updatedAt: env.now };
  s.routines[item.id] = item;
  effect(s, env, "rescheduleRoutine", { routineId: item.id, revision: item.revision });
  return item;
}
function enqueue(s, envelope, env) {
  const e = validateEnvelope(envelope);
  session(s, e.toSessionId);
  if (Object.values(s.deliveries).filter(d => d.envelope.toSessionId === e.toSessionId && d.status === "queued").length >= LIMITS.queuedPerSession)
    fail("budget", "Recipient inbox is full");
  const count = keyed(s.chains, e.chainId) ?? 0;
  if (count >= LIMITS.chainMessages) fail("budget", "Interaction message budget exhausted");
  s.chains[e.chainId] = count + 1;
  s.deliveries[e.id] = { envelope: e, status: "queued", queuedAt: env.now };
  effect(s, env, "publishDelivery", { messageId: e.id });
  effect(s, env, "wakeSession", { sessionId: e.toSessionId });
  return { messageId: e.id, status: "queued", toSessionId: e.toSessionId };
}
function cancelPendingRoutine(s, routineId, env, reason) {
  for (const d of Object.values(s.deliveries)) {
    if (d.status === "queued" && d.envelope.origin.kind === "routine" && d.envelope.origin.routineId === routineId) {
      d.status = "cancelled"; d.finishedAt = env.now; d.reason = reason;
      effect(s, env, "publishDelivery", { messageId: d.envelope.id });
    }
  }
}
function summary(item) {
  return { id: item.id, name: item.name, description: item.description,
    archived: item.archived, revision: item.revision };
}

/** Host/UI entry points. NEVER expose this dispatcher as a model tool. */
export function applyHost(inputState, command, options) {
  const [s, env] = copy(inputState, options);
  const { type } = command;
  let result;
  if (type === "importSession") {
    object(command, ["type", "id", "name", "description", "rolePrompt", "selection", "archived"], ["type", "id", "name", "selection"]);
    identifier(command.id);
    if (keyed(s.sessions, command.id)) fail("conflict", "Session was already imported or deleted");
    if (["__proto__", "constructor", "prototype"].includes(command.id)) fail("invalid", "Unsafe legacy session ID");
    s.sessions[command.id] = { id: command.id, ...profileInput(command), selection: modelSelection(command.selection),
      archived: command.archived === undefined ? false : bool(command.archived, "archived"), deleted: false,
      revision: 1, createdAt: env.now, updatedAt: env.now };
    result = summary(s.sessions[command.id]);
  } else if (type === "userMessage") {
    object(command, ["type", "toSessionId", "body", "submissionId"], ["type", "toSessionId", "body", "submissionId"]);
    session(s, command.toSessionId); text(command.body, "body", LIMITS.body); identifier(command.submissionId);
    const key = `ui:${command.submissionId}`;
    const prior = keyed(s.receipts, key);
    const signature = JSON.stringify([command.toSessionId, command.body]);
    if (prior) { if (prior.signature !== signature) fail("conflict", "Submission ID reused with different content"); return { state: inputState, result: structuredClone(prior.result) }; }
    const id = alloc(s, env);
    result = enqueue(s, { version: 1, id, toSessionId: command.toSessionId, origin: { kind: "user" },
      body: command.body, createdAt: env.now, chainId: id, hop: 0 }, env);
    s.receipts[key] = { signature, result };
    for (const run of Object.values(s.runs)) {
      if (run.sessionId === command.toSessionId && run.status === "running"
          && s.deliveries[run.messageId].envelope.origin.kind !== "user" && !run.cancelRequested) {
        run.cancelRequested = true;
        // Do NOT free the session until native cancellation/persistence is acknowledged.
        effect(s, env, "cancelRun", { runId: run.id, token: run.token, reason: "user_priority" });
      }
    }
  } else if (type === "routineDue") {
    object(command, ["type", "routineId", "revision", "scheduledAt"], ["type", "routineId", "revision", "scheduledAt"]);
    const item = keyed(s.routines, identifier(command.routineId));
    if (!item) fail("not_found", "Routine does not exist");
    revision(item.revision, command.revision); integer(command.scheduledAt, "scheduledAt");
    if (command.scheduledAt > env.now) fail("invalid", "Routine is not due yet");
    session(s, item.ownerSessionId);
    if (!item.enabled) fail("disabled", "Routine is disabled");
    const key = `routine:${item.id}:${command.scheduledAt}`;
    const prior = keyed(s.receipts, key);
    if (prior) return { state: inputState, result: structuredClone(prior.result) };
    const overlap = Object.values(s.deliveries).some(d => ["queued", "running"].includes(d.status)
      && d.envelope.origin.kind === "routine" && d.envelope.origin.routineId === item.id);
    if (overlap) result = { status: "skipped", reason: "overlap" };
    else {
      const id = alloc(s, env);
      result = enqueue(s, { version: 1, id, toSessionId: item.ownerSessionId,
        origin: { kind: "routine", routineId: item.id, name: item.title, scheduledAt: command.scheduledAt },
        body: item.prompt, createdAt: env.now, chainId: id, hop: 0 }, env);
    }
    s.receipts[key] = { result };
  } else if (type === "claimNext") {
    object(command, ["type", "sessionId", "processId"], ["type", "sessionId", "processId"]);
    const item = session(s, command.sessionId); identifier(command.processId);
    if (Object.values(s.runs).some(r => r.sessionId === item.id && r.status === "running"))
      return { state: inputState, result: null };
    const priority = { user: 0, bot: 1, routine: 2 };
    const delivery = Object.values(s.deliveries).filter(d => d.envelope.toSessionId === item.id && d.status === "queued")
      .sort((a, b) => priority[a.envelope.origin.kind] - priority[b.envelope.origin.kind]
        || a.queuedAt - b.queuedAt || a.envelope.id.localeCompare(b.envelope.id))[0];
    if (!delivery) return { state: inputState, result: null };
    const run = { id: alloc(s, env), token: checkedId(env), sessionId: item.id,
      messageId: delivery.envelope.id, processId: command.processId, status: "running", cancelRequested: false,
      startedAt: env.now, profileRevision: item.revision, createdSessions: 0 };
    s.runs[run.id] = run;
    delivery.status = "running"; delivery.runId = run.id;
    result = { run: structuredClone(run), envelope: delivery.envelope, selection: item.selection,
      rolePrompt: composeRolePrompt("", item), prompt: renderWakePrompt(delivery.envelope) };
    // Persist this claim BEFORE invoking Pi. A crash here is ambiguous, not permission to replay tools.
  } else if (type === "completeRun") {
    object(command, ["type", "runId", "token", "status", "error"], ["type", "runId", "token", "status"]);
    const run = keyed(s.runs, identifier(command.runId));
    if (!run || run.token !== command.token) fail("stale_run", "Run completion does not match");
    if (!["completed", "error", "aborted"].includes(command.status)) fail("invalid", "Invalid completion status");
    if (run.status !== "running") return { state: inputState, result: { ignored: true } };
    if (command.error !== undefined) text(command.error, "error", 2000, true);
    run.status = run.cancelRequested ? "aborted" : command.status; run.finishedAt = env.now;
    const d = s.deliveries[run.messageId]; d.status = run.status; d.finishedAt = env.now;
    if (command.error) d.error = command.error;
    effect(s, env, "publishDelivery", { messageId: run.messageId });
    const owner = keyed(s.sessions, run.sessionId);
    if (owner && !owner.deleted && !owner.archived) effect(s, env, "wakeSession", { sessionId: run.sessionId });
    result = { status: run.status };
    // No automatic reply to the sender. It must be an explicit bots_send tool effect.
  } else if (type === "recoverProcess") {
    object(command, ["type", "processId"], ["type", "processId"]); identifier(command.processId);
    for (const run of Object.values(s.runs)) if (run.status === "running" && run.processId !== command.processId) {
      run.status = "interrupted"; run.finishedAt = env.now;
      Object.assign(s.deliveries[run.messageId], { status: "interrupted", finishedAt: env.now,
        error: "Execution was interrupted. Side effects may have happened; manual retry required." });
      effect(s, env, "publishDelivery", { messageId: run.messageId });
    }
    result = { recovered: true };
    // Host drains queued messages only when Android execution rules allow. Recovery does not run agents.
  } else if (["archiveSession", "restoreSession", "deleteSession"].includes(type)) {
    object(command, ["type", "sessionId"], ["type", "sessionId"]);
    const item = session(s, command.sessionId, true);
    if (type === "restoreSession") {
      item.archived = false;
      for (const r of Object.values(s.routines)) if (r.ownerSessionId === item.id)
        effect(s, env, "rescheduleRoutine", { routineId: r.id, revision: r.revision });
      effect(s, env, "wakeSession", { sessionId: item.id });
    } else {
      item.archived = true;
      if (type === "deleteSession") { item.deleted = true; item.rolePrompt = ""; item.description = ""; }
      for (const r of Object.values(s.routines)) if (r.ownerSessionId === item.id) {
        cancelPendingRoutine(s, r.id, env, type);
        effect(s, env, "cancelRoutine", { routineId: r.id });
        if (item.deleted) delete s.routines[r.id];
      }
      for (const run of Object.values(s.runs)) if (run.sessionId === item.id && run.status === "running") {
        run.cancelRequested = true;
        effect(s, env, "cancelRun", { runId: run.id, token: run.token, reason: type });
      }
      if (item.deleted) {
        for (const d of Object.values(s.deliveries)) if (d.envelope.toSessionId === item.id && d.status === "queued") {
          d.status = "cancelled"; d.finishedAt = env.now;
        }
        // The native consumer deletes transcript/config only after any in-flight run terminates.
        effect(s, env, "deleteSessionAfterTermination", { sessionId: item.id });
      }
    }
    item.revision++; item.updatedAt = env.now;
    result = { id: item.id, archived: item.archived, deleted: item.deleted };
  } else if (type === "ackEffect") {
    object(command, ["type", "effectId"], ["type", "effectId"]); identifier(command.effectId);
    s.outbox = s.outbox.filter(e => e.id !== command.effectId); result = { acknowledged: true };
  } else fail("invalid", "Unknown host command");
  return resultState(s, result);
}

export const TOOL_NAMES = Object.freeze(["bots_list", "bots_create", "bots_send", "bot_profile_get", "bot_profile_update",
  "bot_routines_list", "bot_routine_save", "bot_routine_set_enabled", "bot_routine_delete"]);

/** capability is host-only, taken from the authenticated live request; never from tool args. */
export function applyTool(inputState, capability, invocation, options) {
  object(invocation, ["name", "args", "callId"], ["name", "args", "callId"]);
  identifier(invocation.callId); if (!TOOL_NAMES.includes(invocation.name)) fail("forbidden", "No such bot tool");
  const [s, env] = copy(inputState, options);
  const run = runFor(s, capability), self = session(s, run.sessionId);
  const source = s.deliveries[run.messageId].envelope;
  const key = `tool:${run.id}:${invocation.callId}`;
  // Stable serialization avoids false mismatches on harmless object-key reordering.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  const signature = JSON.stringify(canonical({ name: invocation.name, args: invocation.args }));
  const prior = keyed(s.receipts, key);
  if (prior) {
    if (prior.signature !== signature) fail("conflict", "Tool call ID reused with different arguments");
    return { state: inputState, result: structuredClone(prior.result) };
  }
  const a = invocation.args;
  let result;
  if (invocation.name === "bots_list") {
    object(a, ["query", "offset", "limit"]);
    const query = a.query === undefined ? "" : text(a.query, "query", 200, true).toLocaleLowerCase();
    const offset = a.offset === undefined ? 0 : integer(a.offset, "offset");
    const limit = a.limit === undefined ? 20 : integer(a.limit, "limit", 1);
    if (limit > 50) fail("invalid", "limit must be <= 50");
    const items = Object.values(s.sessions).filter(i => !i.deleted && !i.archived
      && `${i.id}\n${i.name}\n${i.description}`.toLocaleLowerCase().includes(query)).sort((l,r) => l.id.localeCompare(r.id));
    result = { items: items.slice(offset, offset + limit).map(summary), total: items.length };
  } else if (invocation.name === "bots_create") {
    object(a, ["name", "description", "rolePrompt", "selection", "routines"], ["name"]);
    if (Object.values(s.sessions).filter(i => !i.deleted).length >= LIMITS.sessions || run.createdSessions >= 4)
      fail("budget", "Bot creation limit reached");
    const routines = a.routines ?? [];
    if (!Array.isArray(routines) || routines.length > LIMITS.routinesPerSession) fail("invalid", "Invalid routines");
    const id = alloc(s, env);
    const item = { id, ...profileInput(a), selection: a.selection === undefined ? structuredClone(self.selection) : modelSelection(a.selection),
      archived: false, deleted: false, revision: 1, createdAt: env.now, updatedAt: env.now };
    s.sessions[id] = item;
    // The native adapter creates a ChatStore conversation with THIS id, not a second bot id.
    effect(s, env, "createSession", { sessionId: id, name: item.name, selection: item.selection });
    const created = routines.map(r => newRoutine(s, id, r, env));
    run.createdSessions++;
    result = { ...summary(item), routines: created };
  } else if (invocation.name === "bot_profile_get") {
    object(a, []); result = { id: self.id, name: self.name, rolePrompt: self.rolePrompt, revision: self.revision };
  } else if (invocation.name === "bot_profile_update") {
    object(a, ["rolePrompt", "revision"], ["rolePrompt", "revision"]);
    revision(self.revision, a.revision); text(a.rolePrompt, "rolePrompt", LIMITS.rolePrompt, true);
    self.rolePrompt = a.rolePrompt; self.revision++; self.updatedAt = env.now;
    effect(s, env, "publishProfile", { sessionId: self.id, revision: self.revision });
    result = { id: self.id, revision: self.revision, rolePrompt: self.rolePrompt, effective: "next_turn" };
  } else if (invocation.name === "bots_send") {
    object(a, ["toSessionId", "body", "replyToMessageId"], ["toSessionId", "body"]);
    session(s, a.toSessionId); text(a.body, "body", LIMITS.body);
    if (a.toSessionId === self.id) fail("invalid", "Use your own context or routine, not self-messaging");
    if (a.replyToMessageId !== undefined) {
      const d = keyed(s.deliveries, identifier(a.replyToMessageId));
      if (!d || d.envelope.toSessionId !== self.id || d.envelope.origin.kind !== "bot"
          || d.envelope.origin.sessionId !== a.toSessionId) fail("forbidden", "Reply target does not match an incoming peer message");
    }
    // Replies are charged to both the current turn and the replied-to chain when different.
    const replied = a.replyToMessageId ? s.deliveries[a.replyToMessageId].envelope : null;
    const hop = Math.max(source.hop, replied?.hop ?? 0) + 1;
    const chainId = replied?.chainId ?? source.chainId;
    if (chainId !== source.chainId) {
      if ((keyed(s.chains, source.chainId) ?? 0) >= LIMITS.chainMessages) fail("budget", "Current interaction budget exhausted");
      s.chains[source.chainId] = (keyed(s.chains, source.chainId) ?? 0) + 1;
    }
    const id = alloc(s, env);
    result = enqueue(s, { version: 1, id, toSessionId: a.toSessionId,
      origin: { kind: "bot", sessionId: self.id, name: self.name }, body: a.body, createdAt: env.now,
      chainId, hop, causationId: source.id,
      ...(a.replyToMessageId === undefined ? {} : { replyToMessageId: a.replyToMessageId }) }, env);
  } else if (invocation.name === "bot_routines_list") {
    object(a, []); result = Object.values(s.routines).filter(r => r.ownerSessionId === self.id);
  } else if (invocation.name === "bot_routine_save") {
    object(a, ["id", "revision", "title", "prompt", "schedule", "enabled"], ["title", "prompt", "schedule"]);
    if (a.id === undefined) {
      if (a.revision !== undefined) fail("invalid", "New routine must not specify revision");
      const { id, revision: unused, ...fields } = a; result = newRoutine(s, self.id, fields, env);
    } else {
      const r = routine(s, a.id, self.id); revision(r.revision, a.revision);
      text(a.title, "title", 80); text(a.prompt, "prompt", LIMITS.body);
      cancelPendingRoutine(s, r.id, env, "routine_edited");
      Object.assign(r, { title: a.title.trim(), prompt: a.prompt, schedule: validateSchedule(a.schedule),
        enabled: a.enabled === undefined ? r.enabled : bool(a.enabled, "enabled"), revision: r.revision + 1, updatedAt: env.now });
      effect(s, env, "rescheduleRoutine", { routineId: r.id, revision: r.revision }); result = r;
    }
  } else if (invocation.name === "bot_routine_set_enabled") {
    object(a, ["id", "revision", "enabled"], ["id", "revision", "enabled"]);
    const r = routine(s, a.id, self.id); revision(r.revision, a.revision);
    r.enabled = bool(a.enabled, "enabled"); r.revision++; r.updatedAt = env.now;
    if (!r.enabled) cancelPendingRoutine(s, r.id, env, "routine_paused");
    effect(s, env, "rescheduleRoutine", { routineId: r.id, revision: r.revision }); result = r;
  } else if (invocation.name === "bot_routine_delete") {
    object(a, ["id", "revision"], ["id", "revision"]);
    const r = routine(s, a.id, self.id); revision(r.revision, a.revision);
    cancelPendingRoutine(s, r.id, env, "routine_deleted");
    delete s.routines[r.id]; effect(s, env, "cancelRoutine", { routineId: r.id }); result = { deleted: r.id };
  }
  s.receipts[key] = { signature, result: structuredClone(result) };
  return resultState(s, result);
}

export function sessionTimeline(state, sessionId) {
  session(state, sessionId, true);
  return Object.values(state.deliveries).filter(d => d.envelope.toSessionId === sessionId
    || (d.envelope.origin.kind === "bot" && d.envelope.origin.sessionId === sessionId))
    .map(d => ({ ...projectMessage(d.envelope, sessionId), status: d.status, ...(d.error ? { error: d.error } : {}), ...(d.reason ? { reason: d.reason } : {}) }))
    .sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
