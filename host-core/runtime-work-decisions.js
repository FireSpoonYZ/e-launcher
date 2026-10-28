import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentDoc, configure, ConversationBusy, SessionFailed } from '@earendil-works/pi-durable';
import { assertId, messageError } from './message-protocol.js';
import { inboxQueryKey } from './message-queries.js';
import { WorkIndex, WorkContextState, ensureWorkBinding, toWorkContextRecord } from './work-context-docs.js';
import { WorkDecisionState, initialDecisionState, toWorkActivity } from './work-decision-state.js';
import { createWorkInput } from './work-decision-codec.js';
import { RequestContext } from './request-context.js';
import { parseModelRef } from './runtime-models.js';

const CONTROL_ERRORS = new Set(['INVALID_ARGUMENT', 'BOT_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'WORK_CONTEXT_INACTIVE', 'NOT_CONNECTED']);
// NOT_CONNECTED 来自 Bot 准入队列关闭（runtime 已在关闭）：只拒绝新准入，不升级为 fatal。
const AUTO_ERRORS = new Set(['WORK_CONTEXT_INACTIVE', 'NOT_CONNECTED']);
const WORK_ERRORS = new Set(['WORK_STOPPED', 'WORK_CONTEXT_INACTIVE', 'STALE_INPUT', 'MODEL_REQUIRED', 'MODEL_NOT_FOUND', 'CONTEXT_LIMIT', 'WORK_GENERATION_FAILED']);
const PUBLICATION_ERRORS = new Set([...WORK_ERRORS, 'INVALID_ARGUMENT', 'BOT_CONTEXT_REQUIRED', 'BOT_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'MESSAGE_NOT_FOUND', 'REQUEST_CONFLICT']);

function finishDecision(state, outcome) {
  const pending = state.pending;
  if (!pending) return;
  state.lastDecision = {
    requestId: pending.requestId,
    outcome,
    throughLocalId: pending.prepared?.throughLocalId ?? null,
    completedAt: new Date().toISOString(),
  };
  state.pending = null;
}

function generationError(reason) {
  // Native detail can contain provider responses or credentials; only retain its small reason code.
  const safeReason = typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason) ? reason : 'unanswered';
  return { code: 'WORK_GENERATION_FAILED', message: 'work generation failed: ' + safeReason };
}

/** Inert until resume(); ledger import, policy consumption and the frozen model view have separate watermarks. */
export function createWorkDecisionRuntime({ host, getHarness, getWorkContexts, models, defaultModel, context, getProfile, admitBot }) {
  let active = false;
  let closing = false;
  let timer = null;
  let pollPromise = null;
  let closePromise = null;
  let fatalError = null;
  const inflight = new Set();
  const lanes = new Map();
  const getLog = () => getWorkContexts().getMessageLog();
  const member = (scope, botId) => scope?.members.some((item) => item.deviceId === host.deviceId && item.botId === botId) === true;
  const currentMember = (meta) => member(getLog().getScope(meta.scopeId), meta.botId);

  function assertHealthy() {
    if (fatalError) throw fatalError;
  }

  function assertOpen() {
    assertHealthy();
    if (closing) throw messageError('WORK_CONTEXT_INACTIVE', 'work decision runtime is closing');
  }

  function fail(error) {
    if (!fatalError) {
      fatalError = error?.code === 'UNSUPPORTED_SCHEMA'
        ? messageError('UNSUPPORTED_SCHEMA', 'work decision runtime schema is unsupported')
        : messageError('WORK_DRIVER_FAILED', 'work decision runtime failed; close and reopen the runtime');
      fatalError.cause = error;
      active = false;
      clearInterval(timer);
      timer = null;
      console.error('Work decision runtime failed; close and reopen the runtime.');
    }
    return fatalError;
  }

  async function guarded(operation, expected, callContext = context) {
    try {
      return await operation();
    } catch (error) {
      if (error === fatalError) throw error;
      if (!(error instanceof SessionFailed) && error?.code !== 'UNSUPPORTED_SCHEMA') {
        if (callContext.abortSignal?.aborted || expected?.has(error?.code)) throw error;
      }
      throw fail(error);
    }
  }

  // botId 非空时在现有 scope lane 之后取得 Bot 准入：同一 Bot 的发送/设置/工作操作串行，
  // 且不重复取同一 lane（决策内部的 syncWorkContext 走 raw 实现）。
  function admit(operation, key, expected = CONTROL_ERRORS, botId = null) {
    try { assertOpen(); } catch (error) { return Promise.reject(error); }
    const previous = key === undefined ? undefined : lanes.get(key);
    const start = () => {
      assertOpen();
      return botId === null ? operation() : admitBot(botId, operation);
    };
    const task = guarded(() => previous ? previous.then(start, start) : Promise.resolve().then(start), expected);
    inflight.add(task);
    if (key !== undefined) lanes.set(key, task);
    const release = () => {
      inflight.delete(task);
      if (key !== undefined && lanes.get(key) === task) lanes.delete(key);
    };
    task.then(release, release);
    return task;
  }

  function inboxAfter(botId, scopeId, afterLocalId, limit = 200) {
    return getLog().inbox(botId, {
      scopeId,
      limit,
      ...(afterLocalId > 0 ? { cursor: {
        deviceId: host.deviceId,
        kind: 'inbox',
        key: inboxQueryKey(botId, scopeId),
        afterLocalId,
      } } : {}),
    });
  }

  async function activity(botId, scopeId) {
    const { binding } = await getWorkContexts().resolveWorkContext(botId, scopeId);
    const harness = getHarness();
    const meta = binding ? await harness.snapshot(WorkContextState, binding.nativeId, context) : null;
    const state = binding ? await harness.snapshot(WorkDecisionState, binding.nativeId, context) : null;
    assertHealthy();
    return toWorkActivity(botId, scopeId, meta ?? null, state ?? initialDecisionState(), member(getLog().getScope(scopeId), botId));
  }

  function getWorkActivity(botId, scopeId) {
    return admit(() => activity(botId, scopeId));
  }

  async function conversationFor(binding) {
    const conversation = await getHarness().conversation(binding.nativeId, context);
    if (!conversation) throw new Error('work conversation is missing');
    return conversation;
  }

  async function abortPending(binding) {
    const conversation = await conversationFor(binding);
    // abort() marks cancellation and waits for ordinary work quiescence, never for a natural model answer.
    await conversation.abort(context);
    await getHarness().commit(async (tx) => {
      finishDecision(await tx.doc(WorkDecisionState, binding.nativeId), 'aborted');
    }, context);
  }

  async function stopWork(botId, scopeId) {
    assertId(botId, 'botId');
    assertId(scopeId, 'scopeId');
    return admit(async () => {
      const { bot, scope } = await getWorkContexts().resolveWorkContext(botId, scopeId);
      const profile = getProfile(botId, { botId, scopeId, kind: scope.kind });
      const binding = await getHarness().commit(async (tx) => {
        const bound = await ensureWorkBinding(tx, host.deviceId, bot, scope, profile);
        (await tx.doc(WorkDecisionState, bound.nativeId)).stopped = true;
        return bound;
      }, context);
      await abortPending(binding);
      return activity(botId, scopeId);
    }, JSON.stringify([botId, scopeId]), CONTROL_ERRORS, botId);
  }

  async function resumeWork(botId, scopeId) {
    assertId(botId, 'botId');
    assertId(scopeId, 'scopeId');
    const result = await admit(async () => {
      const { bot, scope } = await getWorkContexts().resolveWorkContext(botId, scopeId);
      if (!member(getLog().getScope(scopeId), botId)) {
        throw messageError('SCOPE_FORBIDDEN', 'work requires current scope membership');
      }
      const profile = getProfile(botId, { botId, scopeId, kind: scope.kind });
      const binding = await getHarness().commit((tx) => ensureWorkBinding(tx, host.deviceId, bot, scope, profile), context);
      const state = await getHarness().snapshot(WorkDecisionState, binding.nativeId, context);
      const requestId = state?.pending?.requestId;
      // Keep the persistent stop/error fence up until pre-resume native work is fully cancelled.
      if (state?.stopped || (state?.error && state.pending)) await abortPending(binding);
      const record = requestId
        ? await getHarness().commit((tx) => tx.submissionByRequest(binding.nativeId, requestId), context)
        : null;
      await getHarness().commit(async (tx) => {
        const doc = await tx.doc(WorkDecisionState, binding.nativeId);
        assertOpen();
        if (!member(getLog().getScope(scopeId), botId)) {
          throw messageError('SCOPE_FORBIDDEN', 'work requires current scope membership');
        }
        if (record?.status === 'unanswered' && record.reason === 'aborted' && doc.pending?.requestId === record.requestId) {
          finishDecision(doc, 'aborted');
        }
        doc.stopped = false;
        doc.error = null;
      }, context);
      return activity(botId, scopeId);
    }, JSON.stringify([botId, scopeId]), CONTROL_ERRORS, botId);
    nudge();
    return result;
  }

  async function selectModel(tx, nativeId, meta, state, bot) {
    const agent = await tx.doc(AgentDoc, nativeId);
    let ref = agent.model;
    let error = null;
    if (!ref) {
      const configured = bot.modelRef ?? defaultModel;
      if (!configured) error = { code: 'MODEL_REQUIRED', message: 'work model is required' };
      else {
        try { ref = parseModelRef(configured); }
        catch (failure) {
          if (failure?.code !== 'INVALID_ARGUMENT') throw failure;
          error = { code: 'MODEL_NOT_FOUND', message: 'work model reference is invalid' };
        }
      }
    }
    if (!error && !models.getModel(ref.provider, ref.modelId)) {
      error = { code: 'MODEL_NOT_FOUND', message: 'work model is not available' };
    }
    if (error) {
      state.error = error;
      finishDecision(state, 'failed');
      return false;
    }
    if (!agent.model) {
      // 人格/工具由 ensureWorkBinding 写入（SOUL + 工作政策），此处仅选择模型。
      await configure(tx, nativeId, { model: ref });
    }
    return true;
  }

  async function submitPending(binding, bot) {
    const harness = getHarness();
    const input = await harness.commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (closing || fatalError || state.stopped || state.error || !state.pending || state.pending.replan || !currentMember(meta)) return null;
      if (!await selectModel(tx, binding.nativeId, meta, state, bot)) return null;
      return createWorkInput(toWorkContextRecord(meta), state.pending.requestId);
    }, context);
    if (!input) return;
    const conversation = await conversationFor(binding);
    if (closing || fatalError || !member(getLog().getScope(input.entry.data.scopeId), bot.botId)) return;
    let submission;
    try {
      submission = await conversation.submit(input, context);
    } catch (error) {
      if (error instanceof ConversationBusy) return;
      throw error;
    }
    await harness.commit(async (tx) => {
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (state.pending?.requestId === input.requestId) state.pending.submissionId = submission.id;
    }, context);
  }

  async function reconcile(binding, bot) {
    const harness = getHarness();
    const snapshot = await harness.snapshot(WorkDecisionState, binding.nativeId, context);
    if (!snapshot?.pending) return;
    const requestId = snapshot.pending.requestId;
    const meta = await harness.snapshot(WorkContextState, binding.nativeId, context);
    if (snapshot.stopped || !currentMember(meta)) {
      await abortPending(binding);
      return;
    }
    const record = await harness.commit((tx) => tx.submissionByRequest(binding.nativeId, requestId), context);
    if (!record) {
      await submitPending(binding, bot);
      return;
    }
    await harness.commit(async (tx) => {
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      const pending = state.pending;
      if (pending?.requestId !== requestId) return;
      pending.submissionId = record.id;
      if (record.status === 'queued' || record.status === 'placed') return;
      if (state.stopped) {
        finishDecision(state, 'aborted');
      } else if (pending.replan) {
        finishDecision(state, 'replan');
      } else if (record.status === 'done' && pending.prepared && !state.error) {
        state.handledLocalId = Math.max(state.handledLocalId, pending.prepared.throughLocalId);
        finishDecision(state, pending.published ? 'published' : 'silent');
      } else {
        if (!state.error) {
          if (record.reason === 'no_model') {
            const agent = await tx.doc(AgentDoc, binding.nativeId);
            state.error = agent.model
              ? { code: 'MODEL_NOT_FOUND', message: 'work model is not available' }
              : { code: 'MODEL_REQUIRED', message: 'work model is required' };
          } else state.error = generationError(record.status === 'done' ? 'missing_prepared' : record.reason);
        }
        finishDecision(state, 'failed');
      }
    }, context);
  }

  async function startDecision(binding, bot) {
    const created = await getHarness().commit(async (tx) => {
      const meta = await tx.doc(WorkContextState, binding.nativeId);
      const state = await tx.doc(WorkDecisionState, binding.nativeId);
      if (closing || fatalError || state.pending || state.stopped || state.error || !currentMember(meta)) return false;
      // A receive after sync can add another page; do not start on a knowingly incomplete import.
      if (inboxAfter(meta.botId, meta.scopeId, meta.lastImportedLocalId, 1).items.length) return false;
      const items = inboxAfter(meta.botId, meta.scopeId, state.handledLocalId).items
        .filter((item) => item.localId <= meta.lastImportedLocalId);
      if (!items.length) return false;
      const eligible = items.some((item) => !item.selfEcho && (
        (meta.kind === 'room' && item.message.category === 'public') ||
        (meta.kind === 'dm' && item.message.category === 'request')
      ));
      if (!eligible) {
        state.handledLocalId = items[items.length - 1].localId;
        return false;
      }
      if (!await selectModel(tx, binding.nativeId, meta, state, bot)) return false;
      state.pending = {
        requestId: randomUUID(),
        submissionId: null,
        startedAt: new Date().toISOString(),
        prepared: null,
        published: false,
        replan: false,
      };
      return true;
    }, context);
    // Persist the request identity before admission; crash recovery resubmits this exact request, not another turn.
    if (created && !closing && !fatalError) await submitPending(binding, bot);
  }

  async function advance(botId, scopeId) {
    if (!active || closing) return;
    let resolved;
    try { resolved = await getWorkContexts().resolveWorkContext(botId, scopeId); }
    catch (error) {
      // Membership can disappear between discovery and authorization of an as-yet unbound scope.
      if (error?.code === 'SCOPE_FORBIDDEN') return;
      throw error;
    }
    if (!resolved.binding && !inboxAfter(botId, scopeId, 0, 1).items.length) return;
    const imported = await getWorkContexts().syncWorkContext(botId, scopeId, { limit: 200 });
    const { bot, binding } = await getWorkContexts().resolveWorkContext(botId, scopeId);
    if (!binding) throw new Error('work import did not create a binding');
    if (closing || fatalError) return;
    await reconcile(binding, bot);
    if (!imported.hasMore && !closing && !fatalError) await startDecision(binding, bot);
  }

  async function poll() {
    if (!active || closing || !existsSync(join(host.dataRoot, 'messages.sqlite'))) return;
    const pairs = new Map();
    for (const scope of getLog().listScopes()) {
      for (const item of scope.members) {
        if (item.deviceId === host.deviceId) pairs.set(JSON.stringify([item.botId, scope.scopeId]), [item.botId, scope.scopeId]);
      }
    }
    const index = await getHarness().snapshot(WorkIndex, context);
    for (const key of Object.keys(index?.byKey ?? {})) {
      const pair = JSON.parse(key);
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((id) => typeof id !== 'string')) {
        throw new Error('invalid work binding key');
      }
      pairs.set(key, pair);
    }
    const tasks = [];
    for (const [key, [botId, scopeId]] of pairs) {
      if (!active || closing) break;
      if (!lanes.has(key)) tasks.push(admit(() => advance(botId, scopeId), key, AUTO_ERRORS, botId));
    }
    await Promise.all(tasks);
  }

  function nudge() {
    if (!active || closing || fatalError || pollPromise) return;
    pollPromise = admit(poll, undefined, AUTO_ERRORS);
    const clear = () => { pollPromise = null; };
    pollPromise.then(clear, clear);
  }

  function resume() {
    assertOpen();
    if (active) return;
    active = true;
    timer = setInterval(nudge, 1000);
    timer.unref?.();
    nudge();
  }

  function checkWork(meta, state, matchesRequest) {
    // Accepted native tasks drain until harness.close; driver closing only gates new admissions.
    assertHealthy();
    if (state.stopped) throw messageError('WORK_STOPPED', 'work context is stopped');
    if (!state.pending) throw messageError('WORK_CONTEXT_INACTIVE', 'work context has no pending decision');
    if (!matchesRequest) throw messageError('STALE_INPUT', 'work request does not match the pending decision');
    if (state.pending.replan) throw messageError('STALE_INPUT', 'work decision needs newer input');
    if (meta.deviceId !== host.deviceId) throw messageError('WORK_CONTEXT_INACTIVE', 'work context is not local');
    if (!currentMember(meta)) {
      // Commit this fence before throwing, so a quick rejoin cannot turn revoked work into a model failure.
      state.pending.replan = true;
      return { code: 'WORK_CONTEXT_INACTIVE', message: 'work context is not currently active' };
    }
    if (state.error) throw messageError(state.error.code, state.error.message);
    return null;
  }

  async function beforeRequest(_request, api, toolContext) {
    return guarded(async () => {
      const harness = getHarness();
      const meta = await harness.snapshot(WorkContextState, api.conversationId, toolContext);
      if (!meta?.scopeId) return;
      assertHealthy();
      toolContext.abortSignal?.throwIfAborted();
      const task = await harness.getTask(api.taskId, toolContext);
      const cutoff = task?.state?.checkpoint?.cutoff;
      if (!Number.isSafeInteger(cutoff)) throw new Error('work generation has no request cutoff');
      const conversation = await harness.conversation(api.conversationId, toolContext);
      if (!conversation) throw new Error('work conversation is missing');
      const view = await conversation.context(toolContext, { at: cutoff });
      const visible = new Set(view.messages);
      let requestId = null;
      let throughLocalId = 0;
      for (let i = 0; i < view.entries.length; i++) {
        const entry = view.entries[i];
        if (entry.kind === 'host.work-trigger') requestId = entry.data?.requestId ?? null;
        if (entry.kind !== 'host.scope-message' || entry.data?.message?.scopeId !== meta.scopeId) continue;
        if (!(view.contributions[i] ?? []).some((message) => visible.has(message))) continue;
        const localId = entry.data.localId;
        if (!Number.isSafeInteger(localId) || localId < 0) throw new Error('invalid work source watermark');
        throughLocalId = Math.max(throughLocalId, localId);
      }
      const inactive = await harness.commit(async (tx) => {
        const current = await tx.doc(WorkContextState, api.conversationId);
        const state = await tx.doc(WorkDecisionState, api.conversationId);
        toolContext.abortSignal?.throwIfAborted();
        const error = checkWork(current, state, state.pending?.requestId === requestId);
        if (error) return error;
        // Native retries may re-prepare the same task with a new cutoff; capture the actual view each time.
        state.pending.prepared = { taskId: String(api.taskId), cutoff, throughLocalId };
        return null;
      }, toolContext);
      if (inactive) throw messageError(inactive.code, inactive.message);
    }, WORK_ERRORS, toolContext);
  }

  async function checkBudget(_request, api, toolContext) {
    return guarded(async () => {
      const harness = getHarness();
      const meta = await harness.snapshot(WorkContextState, api.conversationId, toolContext);
      if (!meta?.scopeId) return;
      const error = await harness.commit(async (tx) => {
        const current = await tx.doc(WorkContextState, api.conversationId);
        const state = await tx.doc(WorkDecisionState, api.conversationId);
        const prepared = (await tx.doc(RequestContext, api.conversationId)).prepared;
        toolContext.abortSignal?.throwIfAborted();
        const inactive = checkWork(current, state, state.pending?.prepared?.taskId === String(api.taskId));
        if (inactive) return inactive;
        // The manager can reuse the same task's projection when only non-contributing entries advance the cutoff.
        if (!prepared || prepared.taskId !== String(api.taskId)) {
          throw new Error('work context projection does not match the prepared request');
        }
        if (prepared.tokenCount >= prepared.contextWindow) {
          const failure = { code: 'CONTEXT_LIMIT', message: 'work context projection reaches the model context window' };
          state.error = failure;
          return failure;
        }
        return null;
      }, toolContext);
      if (error) throw messageError(error.code, error.message);
    }, WORK_ERRORS, toolContext);
  }

  async function publishWork(publication, api, toolContext) {
    return guarded(async () => {
      assertHealthy();
      const result = await api.commit(async (tx) => {
        const meta = await tx.doc(WorkContextState, api.conversationId);
        const state = await tx.doc(WorkDecisionState, api.conversationId);
        assertHealthy();
        toolContext.abortSignal?.throwIfAborted();
        if (!meta.scopeId || meta.deviceId !== host.deviceId || publication.author?.kind !== 'bot' || publication.author.botId !== meta.botId) {
          throw messageError('BOT_CONTEXT_REQUIRED', 'publication requires the actual local work bot');
        }
        const log = getLog();
        if (log.getMessage(publication.messageId)) {
          const stored = log.publish(publication);
          if (state.pending) state.pending.published = true;
          return stored;
        }
        if (state.stopped) throw messageError('WORK_STOPPED', 'work context is stopped');
        if (!state.pending?.prepared || state.error) throw messageError('WORK_CONTEXT_INACTIVE', 'work context has no prepared decision');
        if (state.pending.replan) throw messageError('STALE_INPUT', 'work decision needs newer input');
        try {
          const stored = log.publish(publication, { scopeId: meta.scopeId, afterLocalId: state.pending.prepared.throughLocalId });
          state.pending.published = true;
          return stored;
        } catch (error) {
          if (error?.code !== 'STALE_INPUT' && !(error?.code === 'SCOPE_FORBIDDEN' && !currentMember(meta))) throw error;
          state.pending.replan = true;
          return { failure: error };
        }
      }, toolContext);
      // Throwing inside commit would roll back replan and permit another provider call on the stale request.
      if (result.failure) throw result.failure;
      return result;
    }, PUBLICATION_ERRORS, toolContext);
  }

  function close() {
    if (!closePromise) {
      closing = true;
      active = false;
      clearInterval(timer);
      timer = null;
      closePromise = (async () => {
        await Promise.allSettled([...inflight]);
        assertHealthy();
      })();
    }
    return closePromise;
  }

  return { resume, close, beforeRequest, checkBudget, publishWork, getWorkActivity, stopWork, resumeWork };
}
