import assert from 'node:assert/strict';
import test from 'node:test';
import {pairToolResults, toolCallKey, summarizeToolArgs, toolOutputPreview, toolResultAttachments} from '../src/toolResults.ts';

const node = (id, role, {toolCalls = [], toolCallId = null, content = id, attachments = []} = {}) => ({
  id,
  parentId: null,
  message: {id, role, content, toolCallId, toolCalls, attachments, incomplete: false},
});
const call = id => ({id, name: id, arguments: '{}'});

test('pairs reordered results by ID without crossing message boundaries', () => {
  const path = [
    node('a1', 'assistant', {toolCalls: [call('one'), call('two')]}),
    node('r2', 'tool', {toolCallId: 'two'}),
    node('r1', 'tool', {toolCallId: 'one'}),
    node('u2', 'user'),
    node('stale', 'tool', {toolCallId: 'one'}),
    node('a2', 'assistant', {toolCalls: [call('one')]}),
    node('fresh', 'tool', {toolCallId: 'one'}),
    node('orphan', 'tool', {toolCallId: 'missing'}),
  ];

  const paired = pairToolResults(path);
  assert.deepEqual(paired.byCall.get(toolCallKey('a1', 0))?.map(n => n.id), ['r1']);
  assert.deepEqual(paired.byCall.get(toolCallKey('a1', 1))?.map(n => n.id), ['r2']);
  assert.deepEqual(paired.byCall.get(toolCallKey('a2', 0))?.map(n => n.id), ['fresh']);
  assert.deepEqual([...paired.embeddedResultIds], ['r2', 'r1', 'fresh']);
  assert.equal(paired.embeddedResultIds.has('stale'), false);
  assert.equal(paired.embeddedResultIds.has('orphan'), false);
});

test('summarizes actual arguments and bounds result previews without changing the full data', () => {
  assert.equal(summarizeToolArgs('{"command":"npm run build","timeout":60}'), 'npm run build');
  assert.equal(summarizeToolArgs('{"path":"web/src/Chat.tsx"}'), 'web/src/Chat.tsx');
  assert.equal(summarizeToolArgs('{"query":"Pi Android client"}'), 'Pi Android client');
  assert.equal(summarizeToolArgs('{"code":"print(1)\\nprint(2)"}'), 'print(1) print(2)');
  assert.equal(summarizeToolArgs('{}'), '');
  assert.equal(summarizeToolArgs('null'), 'null');
  assert.equal(summarizeToolArgs('{"command":'), '{"command":');
  assert.equal(summarizeToolArgs('{"command":42,"path":"a.txt"}'), 'a.txt');
  assert.equal(summarizeToolArgs('x'.repeat(200)), `${'x'.repeat(180)}…`);
  const output = 'first\r\nsecond\r\nthird\r\nfourth';
  assert.equal(toolOutputPreview(output), 'first\nsecond\nthird');
  assert.ok(output.endsWith('fourth'));
  assert.equal(toolOutputPreview('  \n'), '');
  assert.equal(toolOutputPreview('x'.repeat(1000)).length, 600);
});

test('returns persisted tool result attachments for the production tool view', () => {
  const image = {id:'image', name:'tool image', mimeType:'image/png', kind:'image', size:68, path:'/private/image'};
  assert.deepEqual(toolResultAttachments([
    node('image-result', 'tool', {content:'', attachments:[image]}),
    node('text-result', 'tool', {content:'caption'}),
  ]), [image]);
});

test('leaves ambiguous duplicate IDs in one assistant message visible', () => {
  const paired = pairToolResults([
    node('a', 'assistant', {toolCalls: [call('same'), call('same')]}),
    node('result', 'tool', {toolCallId: 'same'}),
  ]);
  assert.equal(paired.embeddedResultIds.has('result'), false);
});
