import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Consumes the synthetic artifact emitted by ConversationBackupsTest after actual ZIP export/import.
// Only host-path adaptation is performed here; this script does not implement the production remapper.
const fixtureRoot = resolve(process.argv[2] ?? 'app/build/backup-sdk-fixture');
const fixture = JSON.parse(await readFile(join(fixtureRoot, 'context.json'), 'utf8'));
assert.equal(fixture.originalDeleted, true);
assert.equal(fixture.entries[0]?.type, 'session');
assert.equal(fixture.entries[0]?.version, 3);
assert(fixture.entries[0].id && fixture.entries[0].timestamp);
const userEntry = fixture.entries.find(entry => entry.type === 'message' && entry.message?.role === 'user');
const block = userEntry?.message.content.find(part => part.type === 'text');
assert(block?.text.endsWith(' bytes): ' + fixture.attachmentPath), 'Java restore must already remap the generated attachment notice');
assert.notEqual(fixture.attachmentPath, fixture.originalPath);
assert.equal(await readFile(join(fixtureRoot, 'attachment.txt'), 'utf8'), 'native attachment');

await mkdir('build', {recursive: true});
const home = await mkdtemp(join(resolve('build'), 'backup-sdk-check-'));
process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
const attachment = join(home, 'restored-attachment.txt');
await writeFile(attachment, await readFile(join(fixtureRoot, 'attachment.txt')));
const entries = structuredClone(fixture.entries);
// Robolectric's private data directory disappears between host JVM and Node processes.
entries[0].cwd = join(home, 'workspace');
const nativeUser = entries.find(entry => entry.type === 'message' && entry.message?.role === 'user');
const text = nativeUser.message.content.find(part => part.type === 'text');
text.text = text.text.slice(0, -fixture.attachmentPath.length) + attachment;
const requests = [], serverErrors = [];
const server = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    assert(requests.length <= 3, 'Unexpected retry loop');
    const last = payload.messages.at(-1);
    let delta, finish;
    if (last?.role === 'tool') {
      assert(JSON.stringify(last.content).includes('native attachment'), 'real read tool must read the copied attachment');
      delta = {role: 'assistant', content: 'restored-sdk-ok'}; finish = 'stop';
    } else {
      assert.equal(requests.length, 1);
      assert(payload.tools.some(tool => tool.function.name === 'read'), 'read tool must be available');
      assert(payload.messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content
        : (message.content ?? []).map(part => part.text ?? '').join('\n')).includes(attachment)),
        'actual SDK request retains restored native user context');
      delta = {role: 'assistant', tool_calls: [{index: 0, id: 'restored-file-read', type: 'function',
        function: {name: 'read', arguments: JSON.stringify({path: attachment})}}]};
      finish = 'tool_calls';
    }
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    response.end(`data: ${JSON.stringify({id:'mock', object:'chat.completion.chunk', choices:[{index:0, delta, finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'mock', object:'chat.completion.chunk', choices:[{index:0, delta:{}, finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    serverErrors.push(error);
    response.writeHead(500, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({error: {message: error.message}}));
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
try {
  const {createSdkRuntime} = await import('../pi-runtime/sdk.js');
  const config = {
    agentDir: join(home, 'agent'), cwd: join(home, 'workspace'), cacheDir: join(home, 'cache'),
    settings: {defaultProvider: 'local', defaultModel: 'mock', defaultTools: ['read'],
      compaction: {enabled: false}, retry: {enabled: false}},
    models: {providers: {local: {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
      models: [{id: 'mock', name: 'Mock', reasoning: false, input: ['text']}]}}},
    auth: {local: {type: 'api_key', key: 'mock-only'}},
  };
  const runtime = await createSdkRuntime({config, sdkHistory: entries}, AbortSignal.timeout(20000));
  const events = []; runtime.subscribe(event => events.push(event));
  await runtime.prompt('Read the restored attachment now.');
  assert.deepEqual(serverErrors, []);
  assert.equal(events.at(-1)?.status, 'completed');
  assert(events.some(event => event.type === 'tool_end' && event.name === 'read' && !event.isError));
  assert(events.some(event => event.type === 'message' && event.message.content === 'restored-sdk-ok'));
  const resumed = events.findLast(event => event.type === 'context').entries;
  assert.equal(resumed[0].type, 'session');
  assert(resumed.some(entry => entry.id === userEntry.id), 'native entry identity survives a real SDK continuation');
  assert.equal(requests.length, 2);
  console.log('PASS: Java ZIP restore -> valid native SessionManager history -> real SDK continuation -> read copied attachment after original deletion (loopback mock only)');
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(home, {recursive: true, force: true});
}
