import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const RPIV_TODO_PACKAGE = "@juicesharp/rpiv-todo";
const TODO_SOURCE = `npm:${RPIV_TODO_PACKAGE}`;
const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const MAX_WIDGET_LINES = 200, MAX_TEXT = 8_000;

function text(value) {
  return stripVTControlCharacters(String(value)).slice(0, MAX_TEXT);
}

function lines(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_WIDGET_LINES).map(text);
}

export class ExtensionUiBridge {
  constructor({ width = 80, theme = {}, ignoredWidgetKeys = new Set() } = {}) {
    this.width = width;
    this.theme = theme;
    this.ignoredWidgetKeys = ignoredWidgetKeys;
    this.widgets = new Map();
    this.statuses = new Map();
    this.notifications = [];
    this.listeners = new Set();
    this.notificationId = 0;
    this.suspended = false;
    this.destroyed = false;
    this.rendering = false;
    this.pendingRender = false;
    const tui = { requestRender: (force = false) => this.requestRender(force) };
    this.ui = {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: (message, type = "info") => {
        if (this.destroyed) return;
        this.notifications = [{ id:++this.notificationId, type:text(type), message:text(message) }];
        this.publish();
      },
      onTerminalInput: () => () => {},
      setStatus: (key, value) => {
        if (this.destroyed) return;
        if (value === undefined) this.statuses.delete(String(key));
        else this.statuses.set(String(key), text(value));
        this.publish();
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options = {}) => {
        if (this.destroyed) return;
        key = String(key);
        if (this.ignoredWidgetKeys.has(key)) return;
        const previous = this.widgets.get(key);
        previous?.component?.dispose?.();
        if (content === undefined) {
          this.widgets.delete(key);
          this.publish();
          return;
        }
        const widget = { key, placement:options.placement === "belowEditor" ? "belowEditor" : "aboveEditor" };
        if (Array.isArray(content) || typeof content === "string") widget.lines = lines(
          typeof content === "string" ? [content] : content);
        else {
          widget.component = content(tui, this.theme);
          widget.lines = lines(widget.component.render(this.width));
        }
        this.widgets.set(key, widget);
        this.publish();
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      get theme() { return theme; },
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  requestRender(force = false) {
    if (this.destroyed) return;
    if (this.rendering) {
      this.pendingRender = true;
      return;
    }
    this.rendering = true;
    try {
      for (const widget of this.widgets.values()) {
        if (!widget.component) continue;
        if (force) widget.component.invalidate?.();
        widget.lines = lines(widget.component.render(this.width));
      }
      this.publish();
    } finally {
      this.rendering = false;
      if (this.pendingRender) {
        this.pendingRender = false;
        this.requestRender();
      }
    }
  }

  subscribe(listener) {
    if (this.destroyed) return () => {};
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return {
      widgets:[...this.widgets.values()].map(({ key, placement, lines: rendered }) => ({ key, placement, lines:[...rendered] })),
      statuses:[...this.statuses].map(([key, value]) => ({ key, text:value })),
      notifications:this.notifications.map((notification) => ({ ...notification })),
    };
  }

  publish() {
    if (this.suspended) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  suspend() {
    this.suspended = true;
  }

  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.suspended = true;
    this.pendingRender = false;
    const components = [...this.widgets.values()].map((widget) => widget.component).filter(Boolean);
    this.widgets.clear();
    this.statuses.clear();
    this.notifications = [];
    this.listeners.clear();
    let failure;
    for (const component of components) {
      try { component.dispose?.(); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}

export async function findRpivTodoTool(tools) {
  const candidate = tools.find((tool) => tool?.name === "todo"
    && (tool.sourceInfo?.source === TODO_SOURCE || tool.sourceInfo?.source?.startsWith(`${TODO_SOURCE}@`))
    && tool.sourceInfo?.origin === "package");
  if (!candidate) return undefined;
  try {
    const base = await realpath(candidate.sourceInfo.baseDir);
    const entry = await realpath(candidate.sourceInfo.path);
    const rel = relative(base, entry);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const manifest = JSON.parse(await readFile(`${base}/package.json`, "utf8"));
    return manifest.name === RPIV_TODO_PACKAGE ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function readTodoSnapshot(details) {
  if (!details || typeof details !== "object" || !Array.isArray(details.tasks)
      || !Number.isSafeInteger(details.nextId) || details.nextId < 1) return undefined;
  const ids = new Set(), tasks = [];
  for (const task of details.tasks) {
    if (!task || typeof task !== "object" || !Number.isSafeInteger(task.id) || task.id < 1
        || ids.has(task.id) || typeof task.subject !== "string" || !TODO_STATUSES.has(task.status)) return undefined;
    ids.add(task.id);
    tasks.push({ id:task.id, subject:task.subject, status:task.status });
  }
  if (tasks.some((task) => task.id >= details.nextId)) return undefined;
  return { tasks, nextId:details.nextId };
}

export function replayRpivTodo(branch, recognizedTool) {
  if (!recognizedTool) return null;
  let snapshot = { tasks:[], nextId:1 };
  for (const entry of branch) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== recognizedTool.name) continue;
    const candidate = readTodoSnapshot(message.details);
    if (candidate) snapshot = candidate;
  }
  return snapshot;
}
