// Forked from @juicesharp/rpiv-todo 2.12.0 (MIT, see LICENSE). The tool contract, reducer and
// result format are retained; the terminal overlay, /todos command, hotkey, config and i18n are
// dropped because Android has no TUI. Each mutation is also saved as a session custom entry: a call
// made inside codemode never becomes a toolResult message, so the upstream replay lost it.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TODO_ENTRY_TYPE = "e-launcher-todo";
const TOOL_NAME = "todo";
const MUTATIONS = new Set(["create", "update", "delete", "clear"]);
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);

/** Validate a persisted snapshot while preserving descriptions, dependencies and metadata. */
export function readTodoState(data) {
  if (!Array.isArray(data?.tasks) || !Number.isSafeInteger(data.nextId) || data.nextId < 1) return undefined;
  const ids = new Set();
  for (const task of data.tasks) {
    if (!task || !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= data.nextId
        || ids.has(task.id) || typeof task.subject !== "string" || !STATUSES.has(task.status)) return undefined;
    ids.add(task.id);
  }
  return { tasks: structuredClone(data.tasks), nextId: data.nextId };
}

/** The snapshot an entry carries: a todo tool result's details or a saved custom entry. */
export function todoEntryData(entry, toolName = TOOL_NAME) {
  if (entry?.type === "custom" && entry.customType === TODO_ENTRY_TYPE) return entry.data;
  const message = entry?.type === "message" ? entry.message : undefined;
  return message?.role === "toolResult" && message.toolName === toolName ? message.details : undefined;
}

/** Custom entries are authoritative; old toolResult snapshots remain readable. */
export function replayTodo(branch, toolName = TOOL_NAME) {
  let saved, legacy;
  for (const entry of branch) {
    const state = readTodoState(todoEntryData(entry, toolName));
    if (!state) continue;
    if (entry.type === "custom") saved = state;
    else legacy = state;
  }
  return saved ?? legacy;
}

const VALID_TRANSITIONS = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};
const isTransitionValid = (from, to) => from === to || VALID_TRANSITIONS[from].has(to);

function detectCycle(tasks, taskId, newBlockedBy) {
  const edges = new Map(tasks.map((task) => [task.id, task.id === taskId
    ? [...new Set([...(task.blockedBy ?? []), ...newBlockedBy])] : [...(task.blockedBy ?? [])]]));
  const visiting = new Set(), visited = new Set();
  const cyclic = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) if (cyclic(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...edges.keys()].some(cyclic);
}

function deriveBlocks(tasks) {
  const blocks = new Map();
  for (const task of tasks) for (const dep of task.blockedBy ?? []) blocks.set(dep, [...(blocks.get(dep) ?? []), task.id]);
  return blocks;
}

const sameNumbers = (a = [], b = []) => a.length === b.length && a.every((value, index) => value === b[index]);
const taskChanged = (before, after) => before.subject !== after.subject || before.status !== after.status
  || before.description !== after.description || before.activeForm !== after.activeForm
  || before.owner !== after.owner || !sameNumbers(before.blockedBy, after.blockedBy)
  || JSON.stringify(before.metadata ?? null) !== JSON.stringify(after.metadata ?? null);
const failure = (state, message) => ({ state, op: { kind: "error", message } });

/** Pure reducer: (state, action, params) → (state, op), validation included. */
export function applyTaskMutation(state, action, params) {
  switch (action) {
    case "create": {
      if (!params.subject?.trim()) return failure(state, "subject required for create");
      for (const dep of params.blockedBy ?? []) {
        const depTask = state.tasks.find((task) => task.id === dep);
        if (!depTask) return failure(state, `blockedBy: #${dep} not found`);
        if (depTask.status === "deleted") return failure(state, `blockedBy: #${dep} is deleted`);
      }
      const task = { id: state.nextId, subject: params.subject, status: "pending" };
      if (params.description) task.description = params.description;
      if (params.activeForm) task.activeForm = params.activeForm;
      if (params.blockedBy?.length) task.blockedBy = [...params.blockedBy];
      if (params.owner) task.owner = params.owner;
      if (params.metadata) task.metadata = { ...params.metadata };
      return { state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 }, op: { kind: "create", taskId: task.id } };
    }
    case "update": {
      if (params.id === undefined) return failure(state, "id required for update");
      const index = state.tasks.findIndex((task) => task.id === params.id);
      if (index === -1) return failure(state, `#${params.id} not found`);
      const current = state.tasks[index];
      const hasMutation = params.subject !== undefined || params.description !== undefined
        || params.activeForm !== undefined || params.status !== undefined || params.owner !== undefined
        || params.metadata !== undefined || params.addBlockedBy?.length > 0 || params.removeBlockedBy?.length > 0;
      if (!hasMutation) {
        return failure(state, "update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy");
      }
      let status = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) return failure(state, `illegal transition ${current.status} → ${params.status}`);
        status = params.status;
      }
      let blockedBy = [...(current.blockedBy ?? [])];
      if (params.removeBlockedBy?.length) {
        const removed = new Set(params.removeBlockedBy);
        blockedBy = blockedBy.filter((dep) => !removed.has(dep));
      }
      if (params.addBlockedBy?.length) {
        for (const dep of params.addBlockedBy) {
          if (dep === current.id) return failure(state, `cannot block #${current.id} on itself`);
          const depTask = state.tasks.find((task) => task.id === dep);
          if (!depTask) return failure(state, `addBlockedBy: #${dep} not found`);
          if (depTask.status === "deleted") return failure(state, `addBlockedBy: #${dep} is deleted`);
          if (!blockedBy.includes(dep)) blockedBy.push(dep);
        }
        if (detectCycle(state.tasks, current.id, blockedBy)) return failure(state, "addBlockedBy would create a cycle in the blockedBy graph");
      }
      let metadata = current.metadata;
      if (params.metadata !== undefined) {
        const merged = { ...(current.metadata ?? {}) };
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        metadata = Object.keys(merged).length ? merged : undefined;
      }
      const updated = { ...current, status };
      if (params.subject !== undefined) updated.subject = params.subject;
      if (params.description !== undefined) updated.description = params.description;
      if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
      if (params.owner !== undefined) updated.owner = params.owner;
      if (blockedBy.length) updated.blockedBy = blockedBy;
      else delete updated.blockedBy;
      if (metadata === undefined) delete updated.metadata;
      else updated.metadata = metadata;
      const tasks = [...state.tasks];
      tasks[index] = updated;
      return { state: { tasks, nextId: state.nextId }, op: { kind: "update", id: updated.id,
        fromStatus: current.status, toStatus: status, changed: taskChanged(current, updated) } };
    }
    case "list":
      return { state, op: { kind: "list", includeDeleted: params.includeDeleted === true,
        ...(params.status !== undefined ? { statusFilter: params.status } : {}) } };
    case "get": {
      if (params.id === undefined) return failure(state, "id required for get");
      const task = state.tasks.find((candidate) => candidate.id === params.id);
      if (!task) return failure(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }
    case "delete": {
      if (params.id === undefined) return failure(state, "id required for delete");
      const index = state.tasks.findIndex((task) => task.id === params.id);
      if (index === -1) return failure(state, `#${params.id} not found`);
      const current = state.tasks[index];
      if (current.status === "deleted") return failure(state, `#${current.id} is already deleted`);
      const tasks = [...state.tasks];
      tasks[index] = { ...current, status: "deleted" };
      return { state: { tasks, nextId: state.nextId }, op: { kind: "delete", id: current.id, subject: current.subject } };
    }
    case "clear":
      return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count: state.tasks.length } };
  }
}

function formatListLine(task) {
  const block = task.blockedBy?.length ? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const form = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
  return `[${task.status}] #${task.id} ${task.subject}${form}${block}`;
}

function formatGetLines(task, state) {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  return lines.join("\n");
}

function formatContent(op, state) {
  switch (op.kind) {
    case "create": {
      const task = state.tasks.find((candidate) => candidate.id === op.taskId);
      return `Created #${task.id}: ${task.subject} (pending)`;
    }
    case "update":
      if (!op.changed) return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
      return `Updated #${op.id}${op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : ""}`;
    case "delete": return `Deleted #${op.id}: ${op.subject}`;
    case "clear": return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((task) => task.status !== "deleted");
      if (op.statusFilter) view = view.filter((task) => task.status === op.statusFilter);
      return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
    }
    case "get": return formatGetLines(op.task, state);
    case "error": return `Error: ${op.message}`;
  }
}

const PROMPT_GUIDELINES = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"completed"} or {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
  "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

const parameters = Type.Object({
  action: StringEnum(["create", "update", "list", "get", "delete", "clear"]),
  subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
  description: Type.Optional(Type.String({ description: "Long-form task description" })),
  activeForm: Type.Optional(Type.String({
    description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')" })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"], {
    description: "Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status." })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only, additive merge)" })),
  owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "Arbitrary metadata; pass null value for a key to delete that key on update" })),
  id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
  includeDeleted: Type.Optional(Type.Boolean({
    description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." })),
});

// Factory-local state: separate runtimes, even with the same cwd, never share tasks.
export default function todoExtension(pi) {
  let state = { tasks: [], nextId: 1 };
  const replay = (_event, ctx) => {
    state = replayTodo(ctx.sessionManager.getBranch()) ?? { tasks: [], nextId: 1 };
  };
  pi.on("session_start", replay);
  pi.on("session_tree", replay);
  pi.on("session_compact", replay);
  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo",
    description: "Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
    promptSnippet: "Manage a task list to track multi-step progress",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters,
    async execute(_toolCallId, params) {
      const { state: next, op } = applyTaskMutation(state, params.action, params);
      if (MUTATIONS.has(params.action) && op.kind !== "error" && op.changed !== false) {
        pi.appendEntry(TODO_ENTRY_TYPE, { tasks: next.tasks, nextId: next.nextId });
      }
      state = next;
      return { content: [{ type: "text", text: formatContent(op, state) }], details: {
        action: params.action, params, tasks: state.tasks, nextId: state.nextId,
        ...(op.kind === "error" ? { error: op.message } : {}) } };
    },
  });
}
