import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const output = new URL('../../build/web-tests/execution-status.mjs', import.meta.url);
await mkdir(new URL('.', output), {recursive:true});
await build({entryPoints:[fileURLToPath(new URL('../src/ExecutionStatus.tsx', import.meta.url))],
  outfile:fileURLToPath(output), bundle:true, platform:'node', format:'esm',
  packages:'external', jsx:'automatic', logLevel:'silent'});
const {executionLabel, ExecutionStatus, RecoveryNotice} = await import(output.href);
const en = (_, english) => english;
test('all live phases have actionable labels and retry details', () => {
  for (const phase of ['thinking','responding','tool','compacting','waiting_user','waiting_shower','stopping','error','interrupted']) {
    assert(executionLabel({phase}, '', en));
    assert(!executionLabel({phase}, '', en).includes('Working'));
  }
  assert.equal(executionLabel({phase:'tool',toolName:'read'},'',en),'Using read');
  assert.equal(executionLabel({phase:'retrying',attempt:2,maxAttempts:3,delayMs:1200},'',en),'Waiting to retry 2/3 · in 2s');
  assert.equal(executionLabel(undefined,'Starting test',en),'Starting test');
});
test('takeover wait is visible and does not animate as model work', () => {
  const html = renderToStaticMarkup(createElement(ExecutionStatus,{execution:{phase:'waiting_shower'}}));
  assert.match(html,/Shower/);
  assert.match(html,/role="status"/);
  assert.doesNotMatch(html,/class="spin"/);
});
test('recovery offers preparation and history, never a resend action', () => {
  let actions=0;
  const render = prepared => renderToStaticMarkup(createElement(RecoveryNotice,
    {prepared,disabled:false,onPrepare:()=>actions++,onHistory:()=>actions++}));
  assert.match(render(false),/准备续接/);
  assert.match(render(false),/外部操作可能已完成/);
  assert.doesNotMatch(render(true),/>准备续接</);
  assert.match(render(true),/手动发送/);
  assert.equal(actions,0);
});
