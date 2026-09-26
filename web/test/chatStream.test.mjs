import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {pairToolResults} from '../src/toolResults.ts';

// Exercise the same stream implementation used by useChat, without a native bridge or DOM.
const output = new URL('../../build/web-tests/chat-stream.mjs', import.meta.url);
await mkdir(new URL('.', output), {recursive:true});
await build({entryPoints:[fileURLToPath(new URL('../src/Chat.tsx', import.meta.url))],
  outfile:fileURLToPath(output), bundle:true, platform:'node', format:'esm',
  packages:'external', jsx:'automatic', logLevel:'silent'});
const {createChatStream, lineage} = await import(output.href);
const node = (id, parentId, role, changes = {}) => ({id, parentId,
  message:{id, role, content:id, toolCalls:[], toolCallId:null, attachments:[], incomplete:false, ...changes}});
const snapshot = () => ({sequence:10, conversationId:'front', requestId:'front-run', running:true,
  conversation:{id:'front', leaf:'streaming', draft:'', draftAttachments:[], piSelection:{}, nodes:[
    node('user', null, 'user'),
    node('call', 'user', 'assistant', {toolCalls:[{id:'read', name:'read', arguments:'{}'}]}),
    node('result', 'call', 'tool', {toolCallId:'read'}),
    node('streaming', 'result', 'assistant', {incomplete:true}),
  ]},
  activeRuns:[{conversationId:'front', requestId:'front-run', status:'running', message:''},
    {conversationId:'back', requestId:'back-run', status:'running', message:''}], extensionUi:{}});
const delta = (sequence, conversationId = 'back') => ({type:'textDelta', sequence, conversationId,
  requestId:`${conversationId}-run`, nodeId:'streaming', payload:{delta:'!'}});
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(read) {
  const state = {server:snapshot(), reads:0, commits:[], replies:[], errors:[], statuses:[]};
  state.stream = createChatStream(() => { state.reads++; return read ? read() : Promise.resolve(state.server); }, {
    snapshot:next => state.commits.push(next), questionnaireReply:reply => state.replies.push(reply),
    error:value => state.errors.push(value), status:value => state.statuses.push(value),
  });
  return state;
}

test('background deltas advance the global cursor without snapshots or visible commits; foreground history props stay stable', async () => {
  const h = harness();
  await h.stream.refresh();
  const before = h.commits.at(-1);
  const previous = pairToolResults(lineage(before.conversation));
  for (let sequence = 11; sequence <= 30; sequence++) h.stream.receive(delta(sequence));
  assert.equal(h.reads, 1);
  assert.equal(h.commits.length, 1);
  h.stream.receive(delta(31, 'front'));
  const after = h.commits.at(-1);
  assert.equal(after.sequence, 31);
  assert.equal(after.conversation.nodes.at(-1).message.content, 'streaming!');
  assert.equal(h.reads, 1, 'background sequences must not look like a gap to the foreground');
  const paired = pairToolResults(lineage(after.conversation), previous);
  for (const oldNode of before.conversation.nodes.slice(0, -1)) {
    assert.equal(after.conversation.nodes.find(n => n.id === oldNode.id), oldNode);
    assert.equal(paired.byMessage.get(oldNode.id), previous.byMessage.get(oldNode.id),
      'unchanged MessageView node/toolResults/pending props satisfy React.memo Object.is');
  }
  assert.equal(paired.byCall.get('call:0'), previous.byCall.get('call:0'));
  assert.notEqual(after.conversation.nodes.at(-1), before.conversation.nodes.at(-1));
});

test('a global sequence gap recovers the snapshot even for a background delta', async () => {
  const h = harness();
  await h.stream.refresh();
  h.stream.receive(delta(11));
  h.server = {...snapshot(), sequence:13, status:'recovered', activeRuns:[]};
  h.stream.receive(delta(13));
  await settle();
  assert.equal(h.reads, 2);
  assert.equal(h.commits.at(-1), h.server);
  assert.equal(h.statuses.at(-1), 'recovered');
  h.stream.receive(delta(12));
  assert.equal(h.reads, 2, 'already covered events are ignored');
});

test('background run status and terminal events refresh activeRuns, and conversation switches still refresh', async () => {
  const h = harness();
  await h.stream.refresh();
  for (const [sequence, type] of [[11, 'runStatus'], [12, 'end']]) {
    h.server = {...h.server, sequence, activeRuns:type === 'end' ? [] : [{conversationId:'back', requestId:'back-run', status:'running', message:'working'}]};
    h.stream.receive({sequence, type, conversationId:'back', requestId:'back-run'});
    await settle();
    assert.equal(h.commits.at(-1).activeRuns, h.server.activeRuns);
  }
  h.server = {...snapshot(), sequence:13, conversationId:'back', requestId:'back-run', conversation:{...snapshot().conversation, id:'back'}};
  h.stream.receive({sequence:13, type:'conversationSwitched', conversationId:'back'});
  await settle();
  assert.equal(h.commits.at(-1).conversationId, 'back');
  h.stream.receive(delta(14));
  assert.equal(h.commits.at(-1).conversation.nodes.at(-1).message.content, 'streaming!');
  assert.equal(h.reads, 4);
});

test('unknown background requests and foreground request mismatches recover rather than applying deltas', async () => {
  const h = harness();
  await h.stream.refresh();
  h.server = {...snapshot(), sequence:11};
  h.stream.receive({...delta(11), requestId:'new-run'});
  await settle();
  h.server = {...snapshot(), sequence:12};
  h.stream.receive({...delta(12, 'front'), requestId:'stale-run'});
  await settle();
  assert.equal(h.reads, 3);
  assert.equal(h.commits.at(-1).conversation.nodes.at(-1).message.content, 'streaming');
});

test('snapshot handshake replays uncovered deltas and preserves covered questionnaire rejection identities', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const refreshing = h.stream.refresh();
  h.stream.receive({type:'questionnaireReply', sequence:9, conversationId:'front', requestId:'front-run',
    payload:{questionnaireId:'question', accepted:false, message:'retry'}});
  h.stream.receive(delta(11));
  h.stream.receive(delta(12, 'front'));
  resolve(snapshot());
  await refreshing;
  assert.equal(h.reads, 1);
  assert.equal(h.commits.at(-1).sequence, 12);
  assert.deepEqual(h.replies, [{sequence:9, conversationId:'front', requestId:'front-run',
    questionnaireId:'question', accepted:false, message:'retry'}]);
  h.stream.dispose();
  await h.stream.refresh();
  h.stream.receive(delta(13));
  assert.equal(h.reads, 1);
  assert.equal(h.commits.at(-1).sequence, 12);
});
