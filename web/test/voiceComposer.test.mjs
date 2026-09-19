import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Render the real composer, without a browser or native plugin calls.
const output = new URL('../../build/web-tests/voice-composer.mjs', import.meta.url);
await mkdir(new URL('.', output), {recursive:true});
await build({entryPoints:[fileURLToPath(new URL('../src/Chat.tsx', import.meta.url))],
  outfile:fileURLToPath(output), bundle:true, platform:'node', format:'esm',
  packages:'external', jsx:'automatic', logLevel:'silent'});
const {ConversationComposer} = await import(output.href);
const conversation = {id:'voice-entry', leaf:null, nodes:[], draft:'', draftAttachments:[], piSelection:{}};
const render = (changes={}, running=false, archived=false) => renderToStaticMarkup(createElement(ConversationComposer,
  {conversation:{...conversation, ...changes}, running, archived, selection:{}, refresh:async()=>{}}));
const voice = /aria-label="打开实时语音对话"/;
const send = /aria-label="发送"/;
const stop = /aria-label="停止生成"/;

test('idle empty composer offers live voice, including whitespace-only drafts', () => {
  for (const draft of ['', ' \n ']) {
    const html = render({draft});
    assert.match(html, voice);
    assert.doesNotMatch(html, send);
    assert.match(html, /aria-label="语音输入"/, 'dictation remains a separate action');
  }
});

test('text or attachments restore send; working keeps stop; archived has no voice entry', () => {
  for (const changes of [{draft:'hello'}, {draftAttachments:[{id:'file', name:'note.txt', kind:'file', mimeType:'text/plain', size:12, path:'/note.txt'}]}]) {
    const html = render(changes);
    assert.doesNotMatch(html, voice);
    assert.match(html, send);
  }
  assert.match(render({}, true), stop);
  assert.doesNotMatch(render({}, true), voice);
  assert.doesNotMatch(render({}, false, true), voice);
});
