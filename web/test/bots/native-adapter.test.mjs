import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the production adapter; only the Capacitor transport is replaced.
const source = await readFile(new URL('../../src/bots/native-adapter.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const importLine = /^import .* from ['"]@capacitor\/core['"];$/m;
assert.match(output, importLine);
async function adapter(transport, available = true) {
    const key = `__bots_transport_${crypto.randomUUID().replaceAll('-', '')}`;
    globalThis[key] = {transport, available, registered: []};
    const code = output.replace(importLine, `const state = globalThis[${JSON.stringify(key)}];
        const Capacitor = {isNativePlatform: () => state.available, isPluginAvailable: name => name === 'Bots' && state.available};
        const registerPlugin = name => { state.registered.push(name); return state.transport; };`);
    try {
        const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
        assert.deepEqual(globalThis[key].registered, ['Bots']);
        return new module.NativeBotUiAdapter();
    } finally { delete globalThis[key]; }
}

test('production adapter reads the registered Android workspace contract and native capabilities', async () => {
    let calls = 0;
    const view = {version: 1, revision: 2, bots: [], messages: [], routines: []};
    const a = await adapter({workspace: async () => {calls++; return {snapshot: view, capabilities: {send: true, delete: false}};}});
    assert.deepEqual(a.capabilities, {});
    assert.equal(await a.read(), view);
    assert.equal(calls, 1);
    assert.equal(a.capabilities.send, true);
    assert.equal(a.capabilities.delete, false);
    assert.equal(a.capabilities.create, false);
});

test('production adapter forwards UI commands without inventing sender or owner identity', async () => {
    const calls = [];
    const a = await adapter({uiAction: async call => {calls.push(call); return {id: 'new-session'};}});
    const send = {toSessionId: 'target', body: '[bot] still user input', submissionId: 'stable-key'};
    await a.send(send);
    assert.deepEqual(calls[0], {action: 'sendUserMessage', input: send});
    assert.deepEqual(await a.createBot({name: 'New', routines: []}), {id: 'new-session'});
    await a.stop('target'); await a.archive('target'); await a.restore('target');
    await a.updateBot({id: 'target', revision: 2});
    await a.deleteBot({id: 'target', revision: 2});
    await a.saveRoutine({ownerSessionId: 'target', title: 'Daily'});
    await a.setRoutineEnabled({id: 'task', revision: 1, enabled: false});
    await a.runRoutine({id: 'task', revision: 2});
    assert.deepEqual(calls.map(c => c.action), ['sendUserMessage', 'createBot', 'stop', 'archive', 'restore',
        'updateBot', 'deleteBot', 'saveRoutine', 'setRoutineEnabled', 'runRoutine']);
});

test('production adapter subscribes and disposes, and never falls back to demo data', async () => {
    let removed = false;
    const listener = () => {};
    const a = await adapter({addListener: async (name, fn) => {
        assert.equal(name, 'botsChanged'); assert.equal(fn, listener);
        return {remove: async () => {removed = true;}};
    }});
    const unsubscribe = await a.subscribe(listener); unsubscribe(); assert.equal(removed, true);
    const missing = await adapter({}, false);
    await assert.rejects(() => missing.read(), /Android APK/);
    assert.throws(() => missing.send({toSessionId: 'x', body: 'x', submissionId: 'x'}), /Android APK/);
});
