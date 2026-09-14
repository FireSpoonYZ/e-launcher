import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

export const RPIV_TODO_PACKAGE = "@juicesharp/rpiv-todo";
export const RPIV_ASK_USER_QUESTION_PACKAGE = "@juicesharp/rpiv-ask-user-question";
const TODO_STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const MAX_WIDGET_LINES = 200, MAX_TEXT = 8_000;

function text(value) {
  return stripVTControlCharacters(String(value)).slice(0, MAX_TEXT);
}

function lines(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_WIDGET_LINES).map(text);
}

function normalizeLineTerminators(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function normalizeQuestionParams(params) {
  if (!params || typeof params !== "object" || !Array.isArray(params.questions)) return params;
  return {
    ...params,
    questions:params.questions.map((question) => ({
      ...question,
      question:typeof question.question === "string" ? normalizeLineTerminators(question.question) : question.question,
      header:typeof question.header === "string" ? normalizeLineTerminators(question.header) : question.header,
      options:Array.isArray(question.options) ? question.options.map((option) => ({
        ...option,
        label:typeof option.label === "string" ? normalizeLineTerminators(option.label) : option.label,
        description:typeof option.description === "string" ? normalizeLineTerminators(option.description) : option.description,
        ...(typeof option.preview === "string" ? { preview:normalizeLineTerminators(option.preview) } : {}),
      })) : question.options,
    })),
  };
}

function questionState(params, id) {
  return {
    id,
    questions:params.questions.map((question, questionIndex) => ({
      questionIndex,
      question:question.question,
      header:question.header,
      multiSelect:question.multiSelect === true,
      options:question.options.map((option) => ({
        label:option.label,
        description:option.description,
        ...(typeof option.preview === "string" ? { preview:option.preview } : {}),
      })),
    })),
  };
}

function nonEmptyTrimmed(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("问卷备注必须是文本");
  const trimmed = value.trim();
  return trimmed || undefined;
}

function questionnaireResult(prompt, value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.answers)) {
    throw new Error("问卷答案格式无效");
  }
  const used = new Set(), answers = [];
  for (const candidate of value.answers) {
    if (!candidate || typeof candidate !== "object" || !Number.isSafeInteger(candidate.questionIndex)
        || candidate.questionIndex < 0 || candidate.questionIndex >= prompt.questions.length
        || used.has(candidate.questionIndex)) throw new Error("问卷题号无效或重复");
    used.add(candidate.questionIndex);
    const question = prompt.questions[candidate.questionIndex];
    const labels = new Map(question.options.map((option) => [option.label, option]));
    const notes = nonEmptyTrimmed(candidate.notes);
    if (candidate.kind === "option") {
      if (question.multiSelect || typeof candidate.answer !== "string" || !labels.has(candidate.answer)) {
        throw new Error("问卷单选答案无效");
      }
      const option = labels.get(candidate.answer);
      answers.push({
        questionIndex:candidate.questionIndex,
        question:question.question,
        kind:"option",
        answer:candidate.answer,
        ...(notes ? { notes } : {}),
        ...(typeof option.preview === "string" ? { preview:option.preview } : {}),
      });
    } else if (candidate.kind === "multi") {
      if (!question.multiSelect || !Array.isArray(candidate.selected)
          || candidate.selected.some((label) => typeof label !== "string" || !labels.has(label))
          || new Set(candidate.selected).size !== candidate.selected.length) {
        throw new Error("问卷多选答案无效");
      }
      answers.push({
        questionIndex:candidate.questionIndex,
        question:question.question,
        kind:"multi",
        answer:null,
        selected:[...candidate.selected],
        ...(notes ? { notes } : {}),
      });
    } else if (candidate.kind === "custom") {
      if (candidate.answer !== null && typeof candidate.answer !== "string") throw new Error("问卷自定义答案无效");
      answers.push({
        questionIndex:candidate.questionIndex,
        question:question.question,
        kind:"custom",
        answer:candidate.answer,
        ...(notes ? { notes } : {}),
      });
    } else throw new Error("问卷答案类型无效");
  }
  answers.sort((left, right) => left.questionIndex - right.questionIndex);
  const globalNote = nonEmptyTrimmed(value.globalNote);
  return { answers, cancelled:false, ...(globalNote ? { globalNote } : {}) };
}

/** Minimal ExtensionUIContext used by non-terminal hosts. */
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
    this.askContext = new AsyncLocalStorage();
    this.askQueue = Promise.resolve();
    this.askUser = null;
    this.pendingAsk = null;
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
        if (Array.isArray(content) || typeof content === "string") {
          widget.lines = lines(typeof content === "string" ? [content] : content);
        } else {
          widget.component = content(tui, this.theme);
          widget.lines = lines(widget.component.render(this.width));
        }
        this.widgets.set(key, widget);
        this.publish();
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => {
        const current = this.askContext.getStore();
        return current ? this.enqueueAsk(current.params, current.signal) : undefined;
      },
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      get theme() { return theme; },
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  runAskUserQuestion(params, signal, execute) {
    return this.askContext.run({ params:normalizeQuestionParams(params), signal }, execute);
  }

  enqueueAsk(params, signal) {
    const request = this.askQueue.then(() => this.requestAsk(params, signal));
    this.askQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  async requestAsk(params, signal) {
    if (this.destroyed) throw new Error("问卷宿主已关闭");
    signal?.throwIfAborted();
    const prompt = questionState(params, randomUUID());
    this.askUser = prompt;
    this.publish();
    try {
      return await new Promise((resolve, reject) => {
        const pending = { id:prompt.id, prompt, resolve, reject, settled:false, signal, onAbort:undefined };
        pending.onAbort = () => {
          if (pending.settled) return;
          pending.settled = true;
          reject(signal.reason ?? new Error("问卷已中止"));
        };
        this.pendingAsk = pending;
        signal?.addEventListener("abort", pending.onAbort, { once:true });
        if (signal?.aborted) pending.onAbort();
      });
    } finally {
      const pending = this.pendingAsk;
      if (pending?.id === prompt.id) {
        pending.signal?.removeEventListener("abort", pending.onAbort);
        this.pendingAsk = null;
      }
      if (this.askUser?.id === prompt.id) this.askUser = null;
      this.publish();
    }
  }

  replyAskUserQuestion(id, result) {
    const pending = this.pendingAsk;
    if (!pending || pending.id !== id || pending.settled) throw new Error("问卷请求已失效");
    const validated = questionnaireResult(pending.prompt, result);
    pending.settled = true;
    pending.resolve(validated);
  }

  cancelAskUserQuestion(id) {
    const pending = this.pendingAsk;
    if (!pending || pending.id !== id || pending.settled) throw new Error("问卷请求已失效");
    pending.settled = true;
    pending.resolve({ answers:[], cancelled:true });
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
      widgets:[...this.widgets.values()].map(({ key, placement, lines: rendered }) => ({
        key, placement, lines:[...rendered],
      })),
      statuses:[...this.statuses].map(([key, value]) => ({ key, text:value })),
      notifications:this.notifications.map((notification) => ({ ...notification })),
      askUser:this.askUser ? structuredClone(this.askUser) : null,
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
    const pending = this.pendingAsk;
    if (pending && !pending.settled) {
      pending.settled = true;
      pending.reject(new Error("问卷宿主已关闭"));
    }
    const components = [...this.widgets.values()].map((widget) => widget.component).filter(Boolean);
    this.widgets.clear();
    this.statuses.clear();
    this.notifications = [];
    this.askUser = null;
    this.listeners.clear();
    let failure;
    for (const component of components) {
      try { component.dispose?.(); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}

export async function findPackageTool(tools, toolName, packageName) {
  const source = `npm:${packageName}`;
  const candidate = tools.find((tool) => tool?.name === toolName
    && (tool.sourceInfo?.source === source || tool.sourceInfo?.source?.startsWith(`${source}@`))
    && tool.sourceInfo?.origin === "package");
  if (!candidate) return undefined;
  try {
    const base = await realpath(candidate.sourceInfo.baseDir);
    const entry = await realpath(candidate.sourceInfo.path);
    const rel = relative(base, entry);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const manifest = JSON.parse(await readFile(`${base}/package.json`, "utf8"));
    return manifest.name === packageName ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function findRpivTodoTool(tools) {
  return findPackageTool(tools, "todo", RPIV_TODO_PACKAGE);
}

export function findRpivAskUserQuestionTool(tools) {
  return findPackageTool(tools, "ask_user_question", RPIV_ASK_USER_QUESTION_PACKAGE);
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
  return { package:RPIV_TODO_PACKAGE, tasks, nextId:details.nextId };
}

export function replayRpivTodo(branch, recognizedTool) {
  if (!recognizedTool) return null;
  let snapshot = { package:RPIV_TODO_PACKAGE, tasks:[], nextId:1 };
  for (const entry of branch) {
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== recognizedTool.name) continue;
    const candidate = readTodoSnapshot(message.details);
    if (candidate) snapshot = candidate;
  }
  return snapshot;
}
