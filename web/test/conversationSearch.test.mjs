import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { LatestRequest } from '../src/latestRequest.ts';

// The native bridge owns matching (including body-only matches); UI must not re-filter its result.
test('both conversation lists use native query and render native snippets without title filtering', () => {
  const source = readFileSync(new URL('../src/Chat.tsx', import.meta.url), 'utf8');
  const search = source.slice(source.indexOf('function useConversationSearch'), source.indexOf('function ModelSheet'));
  const archived = source.slice(source.indexOf('export function ArchivedPage'));
  assert.match(search, /Chat\.listArchivedConversations\(\{query: search\}\)/);
  assert.match(search, /Chat\.listConversations\(\{query: search\}\)/);
  assert.match(search, /result\.query === search/);
  for (const list of [search, archived]) {
    assert.doesNotMatch(list, /title\.toLowerCase\(\)\.includes/);
    assert.match(list, /item\.snippet/);
  }
});

test('out-of-order refresh, query change, and unmount cannot replace current search results', async () => {
  const gate = new LatestRequest();
  const pending = [];
  let live = true;
  let shown = [];
  const load = () => {
    const request = gate.begin();
    return new Promise(resolve => pending.push(resolve)).then(items => {
      if (live && gate.current(request)) shown = items;
    });
  };
  const old = load();
  const current = load();
  pending[1]([{title: '标题', snippet: '中文正文命中'}]);
  await current;
  pending[0]([{title: 'old'}]);
  await old;
  assert.equal(shown[0].snippet, '中文正文命中');
  const eventRefresh = load();
  live = false; // effect cleanup on query change / unmount
  pending[2]([{title: 'late archive event'}]);
  await eventRefresh;
  assert.equal(shown[0].snippet, '中文正文命中');
});
