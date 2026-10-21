import { defineDoc } from '@earendil-works/pi-durable';

export function initialDecisionState() {
  return {
    stopped: false,
    handledLocalId: 0,
    pending: null,
    lastDecision: null,
    error: null,
  };
}

export const WorkDecisionState = defineDoc({
  kind: 'host.work-decision',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: initialDecisionState,
});

/** 传入 tx.doc 草稿时须在 commit 内调用，逐字段复制，不能带出已结算的 overlay。 */
export function toWorkActivity(botId, scopeId, meta, state, isMember) {
  const conversationId = meta?.conversationId ?? null;
  const pending = state.pending;
  const lastDecision = state.lastDecision;
  const error = state.error;
  let status;
  if (conversationId === null) status = 'unbound';
  else if (state.stopped) status = 'stopped';
  else if (error !== null) status = 'error';
  else if (!isMember) status = 'inactive';
  else if (pending !== null) status = 'thinking';
  else status = 'idle';

  return {
    botId,
    scopeId,
    conversationId,
    isMember,
    status,
    stopped: state.stopped,
    lastImportedLocalId: meta?.lastImportedLocalId ?? 0,
    handledLocalId: state.handledLocalId,
    pending: pending === null ? null : {
      requestId: pending.requestId,
      submissionId: pending.submissionId,
      startedAt: pending.startedAt,
      preparedThroughLocalId: pending.prepared?.throughLocalId ?? null,
    },
    lastDecision: lastDecision === null ? null : {
      requestId: lastDecision.requestId,
      outcome: lastDecision.outcome,
      throughLocalId: lastDecision.throughLocalId,
      completedAt: lastDecision.completedAt,
    },
    error: error === null ? null : {
      code: error.code,
      message: error.message,
    },
  };
}
