import assert from 'node:assert/strict';
import sessionBots from './extensions/session-bots/index.js';
const hooks = new Map(), tools = [], calls = [];
sessionBots({ on: (name, handler) => hooks.set(name, handler), registerTool: tool => tools.push(tool) }, {
  profile: { id: 'a', name: 'A', rolePrompt: 'Use Rust.' },
  request: async (...args) => { calls.push(args); return { id: 'delivery', status: 'queued' }; },
});
assert.equal(tools.length, 1);
assert.equal(tools[0].name, 'bots');
assert.ok(hooks.get('before_agent_start')({ systemPrompt: 'BASE' }).systemPrompt.startsWith('BASE'));
assert.ok(hooks.get('before_agent_start')({ systemPrompt: 'BASE' }).systemPrompt.includes('Use Rust.'));
assert.equal(tools[0].parameters.additionalProperties, false);
const controller = new AbortController();
const result = await tools[0].execute('call-1', { action: 'send', targetId: 'b', message: 'Hello' }, controller.signal);
assert.equal(calls[0][2], 'call-1');
assert.equal(calls[0][1], controller.signal);
assert.equal(JSON.parse(result.content[0].text).status, 'queued');
await assert.rejects(() => tools[0].execute('bad', { action: 'delete' }, controller.signal));
await assert.rejects(() => tools[0].execute('bad', { action: 'role', rolePrompt: 'x', ownerId: 'b' }, controller.signal));
console.log('PASS: session-bots extension registration and SDK schema checks');
