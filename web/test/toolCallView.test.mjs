import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const output = new URL('../../build/web-tests/tool-call-view.mjs', import.meta.url);
await mkdir(new URL('.', output), {recursive: true});
await build({
  entryPoints: [fileURLToPath(new URL('../src/ToolCallView.tsx', import.meta.url))],
  outfile: fileURLToPath(output),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
  logLevel: 'silent',
});
const {ToolCallView} = await import(output.href);

const result = (id, content, attachments = []) => ({
  id,
  parentId: null,
  message: {id, role: 'tool', content, toolCallId: id, toolCalls: [], attachments, incomplete: false},
});
const html = props => renderToStaticMarkup(createElement(ToolCallView, props));
const summaryOf = markup => markup.match(/<summary>[\s\S]*?<\/summary>/)[0];

test('expanded tool text keeps the original string outside the collapsed summary', () => {
  const args = '{"command":"npm test","code":"KEEP  SPACES\\nAND\\tTABS & <script>alert(1)</script>"}';
  const marker = 'UNIQUE_TAIL_MARKER';
  const markup = html({
    tool: {id: 'bash', name: 'Bash', arguments: args},
    results: [
      result('one', `first\nsecond\nthird\nfourth ${marker}`),
      result('blank', ''),
      result('two', 'beta\nline'),
    ],
  });
  const summary = summaryOf(markup);
  assert.match(summary, /tool-preview/);
  assert.match(summary, /npm test/);
  assert.doesNotMatch(summary, /<pre|tool-fullscreen|全屏查看|aria-label="复制"|UNIQUE_TAIL_MARKER|beta/);
  assert.ok((markup.match(/aria-label="复制"/g) ?? []).length >= 2);
  assert.doesNotMatch(markup, /is-overflow|tool-fullscreen|role="dialog"/);
  assert.doesNotMatch(markup, /<pre[^>]*onclick/);
  const escaped = args.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  assert.ok(markup.includes(escaped));
  assert.ok(markup.includes(`fourth ${marker}\n\nbeta\nline`));
  assert.doesNotMatch(markup, /<script/i);
});

test('short or empty results do not invent a fullscreen control', () => {
  const pending = html({tool: {id: 'read', name: 'Read', arguments: ''}, results: [], pending: true});
  assert.match(pending, />\{\}<\/pre>/);
  assert.match(pending, /等待结果/);
  assert.match(pending, /结果返回后会显示在这里/);
  assert.equal((pending.match(/aria-label="复制"/g) ?? []).length, 1);

  const bare = html({results: [], pending: false});
  assert.match(bare, /无结果/);
  assert.match(bare, /本次调用没有结果记录/);
  assert.doesNotMatch(bare, /aria-label="复制"|全屏查看/);
});
