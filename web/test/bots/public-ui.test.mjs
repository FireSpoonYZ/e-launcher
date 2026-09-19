import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyHost, applyTool } from '../../../pi-runtime/session-bots/core.mjs';
import { projectPublicUi } from '../../../pi-runtime/session-bots/public-ui.mjs';
import { validateSnapshot, pairMessages } from '../../src/bots/model.mjs';
function fixture() {
    let state = emptyState(), i = 0;
    const opts = () => ({ now: 1800000000000 + i, id: () => `gen-${++i}` });
    const host = c => { const o = applyHost(state, c, opts()); state = o.state; return o.result; };
    for (const [id, name] of [['A', '管家'], ['B', '研究员']])
        host({ type: 'importSession', id, name, selection: { provider: 'test', model: 'test-model' } });
    host({ type: 'userMessage', toSessionId: 'A', body: '研究一下', submissionId: 'u1' });
    const { run } = host({ type: 'claimNext', sessionId: 'A', processId: 'p1' });
    const o = applyTool(state, { runId: run.id, token: run.token }, { name: 'bots_send', args: { toSessionId: 'B', body: '请研究' }, callId: 'call-1' }, opts());
    state = o.state;
    return { state, run };
}
test('actual core transitions project to UI without any tokens or outbox', () => { const { state, run } = fixture(); const out = projectPublicUi(state); const s = JSON.stringify(out); assert(!s.includes(run.token)); assert(!s.includes('outbox')); assert(!s.includes('receipts')); assert.equal(pairMessages(validateSnapshot(out), 'A', 'B').length, 1); });
test('actual active run becomes working avatar; archived remains authoritative', () => { const { state } = fixture(); const v = validateSnapshot(projectPublicUi(state)); assert.equal(v.bots.find(b => b.id === 'A').activity, 'working'); });
test('assistant transcript projection is explicitly assistant, never bot send', () => { const { state } = fixture(); const v = validateSnapshot(projectPublicUi(state, { assistantMessages: [{ id: 'answer', sessionId: 'A', body: 'done', createdAt: 1800000004000 }] })); assert.equal(v.messages.at(-1).source.kind, 'assistant'); assert.equal(pairMessages(v, 'A', 'B').length, 1); });
test('public projection drops deleted bots, but names remain on surviving peer records', () => { const { state } = fixture(); state.sessions.A.deleted = true; const v = validateSnapshot(projectPublicUi(state)); assert(!v.bots.some(b => b.id === 'A')); assert.equal(pairMessages(v, 'A', 'B').length, 1); });
test('host must supply composite revision for activity/transcript/UI-only changes', () => { const { state } = fixture(); assert.equal(projectPublicUi(state, { revision: 100 }).revision, 100); });
