import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeKey, encodeText, encodePaste, hardwareBinding, hardwareKeyDown, isTerminalSendWithinLimit, TERMINAL_SEND_MAX_BYTES, LiveInput } from '../src/RemoteTerminal/input.ts';
import { bindTerminalTextFieldSubmit } from '../src/RemoteTerminal/orca/terminal-text-field-submit-binding.web.ts';
import { createTerminalAccessoryRepeatController } from '../src/RemoteTerminal/orca/terminal-accessory-repeat.ts';
import { routeScrollLines, buildMouseClickInput } from '../src/RemoteTerminal/gestures.ts';
import { isTerminalGestureInput } from '../src/RemoteTerminal/orca/terminal-gesture-input.ts';
const modes={applicationCursor:false,bracketedPaste:false,kittyFlags:0};

test('Orca key chords, application cursor and modified Enter share hardware/accessory encoding', () => {
  assert.equal(encodeKey({key:'c',modifiers:['ctrl']},modes),'\x03');
  assert.equal(encodeKey({key:'tab',modifiers:['shift']},modes),'\x1b[Z');
  assert.equal(encodeKey({key:'arrowUp',modifiers:[]},{...modes,applicationCursor:true}),'\x1bOA');
  assert.equal(encodeKey({key:'arrowUp',modifiers:['alt','shift']},modes),'\x1b[1;4A');
  const binding=hardwareBinding({key:'Enter',shiftKey:true,ctrlKey:false,altKey:false});
  assert.equal(encodeKey(binding,modes),'\x1b[13;2u');
  assert.equal(encodeKey(binding,{...modes,kittyFlags:1}),'\x1b[13;2u');
});
test('Kitty report-all committed text and release events use the xterm encoder', () => {
  assert.equal(encodeText('中a',{...modes,kittyFlags:8}),'\x1b[20013u\x1b[97u');
  assert.equal(encodeKey({key:'a',modifiers:[]},{...modes,kittyFlags:10},3),'\x1b[97;1:3u');
  assert.equal(encodeKey({key:'a',modifiers:[]},modes,3),'');
});
test('Kitty committed uppercase and supplementary Unicode retain literal codepoints', () => {
  const kitty={...modes,kittyFlags:8};
  assert.equal(encodeText('Foo🙂',kitty),'\x1b[70u\x1b[111u\x1b[111u\x1b[128578u');
  assert.equal(encodePaste('A中',kitty),'\x1b[65u\x1b[20013u');
  assert.equal(encodeText('A',{...kitty,kittyFlags:24}),'\x1b[65;;65u');
});
test('hardware decision keeps physical shifted digits, keypad and flags3 printable releases', () => {
  const event={key:'a',code:'KeyA',ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,repeat:false,isComposing:false,keyCode:65};
  const mode={...modes,kittyFlags:3};
  const press=hardwareKeyDown(event,mode,[]);
  assert.ok(press);
  assert.equal(press.binding.code,'KeyA');
  assert.equal(encodeKey(press.binding,mode,press.eventType),'a');
  assert.equal(encodeKey(hardwareBinding(event),mode,3),'\x1b[97;1:3u');
  const shifted=hardwareKeyDown({...event,key:'!',code:'Digit1',shiftKey:true},{...mode,kittyFlags:8},[]);
  assert.equal(encodeKey(shifted.binding,{...mode,kittyFlags:8}),'\x1b[49;2u');
  const keypad=hardwareKeyDown({...event,key:'1',code:'Numpad1'},{...mode,kittyFlags:1},[]);
  assert.equal(encodeKey(keypad.binding,{...mode,kittyFlags:1}),'\x1b[57400u');
  assert.equal(hardwareKeyDown({...event,isComposing:true},mode,[]),null);
});
test('64 KiB limit checks encoded UTF8, bracketed paste overhead and preserves rejected mirror draft', () => {
  assert.equal(isTerminalSendWithinLimit('a'.repeat(TERMINAL_SEND_MAX_BYTES)),true);
  assert.equal(isTerminalSendWithinLimit('a'.repeat(TERMINAL_SEND_MAX_BYTES+1)),false);
  assert.equal(isTerminalSendWithinLimit('中'.repeat(21845)+'a'),true);
  assert.equal(isTerminalSendWithinLimit('中'.repeat(21846)),false);
  assert.equal(isTerminalSendWithinLimit('中'.repeat(30000)),false);
  const bracketed={...modes,bracketedPaste:true};
  assert.equal(isTerminalSendWithinLimit(encodePaste('a'.repeat(65524),bracketed)),true);
  assert.equal(isTerminalSendWithinLimit(encodePaste('a'.repeat(65525),bracketed)),false);
  const kitty={...modes,kittyFlags:8};
  assert.equal(isTerminalSendWithinLimit(encodeText('A'.repeat(14000),kitty)),false);
  const input=new LiveInput(); input.change('draft');
  const draft='draft'+'中'.repeat(30000);
  assert.equal(input.change(draft,data => isTerminalSendWithinLimit(encodeText(data,modes))),null);
  assert.equal(input.sentText,'draft');
  assert.equal(input.change('draft好',isTerminalSendWithinLimit),'好');
});
test('Chinese composition is held, committed once and supports codepoint corrections', () => {
  const input=new LiveInput();
  input.composing=true;
  assert.equal(input.change('ni'),'');
  assert.equal(input.change('你'),'');
  input.composing=false;
  assert.equal(input.change('你'),'你');
  assert.equal(input.change('你'),'');
  assert.equal(input.change('你好'),'好');
  assert.equal(input.change('你'),'\x7f');
  input.reset();
  assert.equal(input.change('🙂'),'🙂');
  assert.equal(input.change(''),'\x7f');
});
test('Orca beforeinput submit ignores composition updates and binds/unbinds exactly once', () => {
  class Field extends EventTarget {}
  class Input extends Event { constructor(inputType) { super('beforeinput',{cancelable:true}); this.inputType=inputType; } }
  const originals=[globalThis.HTMLInputElement,globalThis.HTMLTextAreaElement,globalThis.InputEvent];
  globalThis.HTMLInputElement=Field; globalThis.HTMLTextAreaElement=Field; globalThis.InputEvent=Input;
  try {
    const field=new Field(); let submits=0;
    const input=new LiveInput(); const sent=[];
    input.composing=true; assert.equal(input.change('ni'),'');
    input.composing=false; sent.push(input.change('你')); // compositionend
    assert.equal(input.change('你'),''); // trailing input event must not duplicate the commit
    const unbind=bindTerminalTextFieldSubmit(field,() => { submits++; sent.push(input.change('你') + encodeKey({key:'enter',modifiers:[]},modes)); input.reset(); });
    field.dispatchEvent(new Input('insertCompositionText'));
    assert.equal(submits,0);
    const line=new Input('insertLineBreak'); field.dispatchEvent(line);
    assert.equal(submits,1); assert.equal(line.defaultPrevented,true);
    assert.deepEqual(sent,['你','\r']);
    unbind(); field.dispatchEvent(new Input('insertLineBreak')); assert.equal(submits,1);
  } finally { [globalThis.HTMLInputElement,globalThis.HTMLTextAreaElement,globalThis.InputEvent]=originals; }
});
test('paste is bracketed only when negotiated and does not invent Enter', () => {
  assert.equal(encodePaste('你好',modes),'你好');
  assert.equal(encodePaste('a\nb',{...modes,bracketedPaste:true}),'\x1b[200~a\rb\x1b[201~');
});
test('Orca repeat cancellation prevents held key from repeating after control loss', async context => {
  context.mock.timers.enable({apis:['setTimeout','Date']});
  const repeat=createTerminalAccessoryRepeatController(); const sent=[];
  repeat.start('up',async key => { sent.push(key); return true; });
  await Promise.resolve();
  context.mock.timers.tick(400); await Promise.resolve();
  assert.deepEqual(sent,['up','up']);
  repeat.stop(); context.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(sent.length,2);
});
test('Orca gestures scroll history, route alternate-screen arrows, encode mouse taps and bound sequences', () => {
  const sent=[],scroll=[];
  const scope={term:{cols:80,rows:24,modes:{mouseTrackingMode:'none',applicationCursorKeysMode:false},buffer:{active:{type:'normal'}},scrollLines:lines => scroll.push(lines)},rect:{left:0,top:0,width:800,height:240},mouseEncodingKnown:true,sgrMouseMode:true,sgrMousePixelsMode:false,send:bytes => sent.push(bytes)};
  routeScrollLines(scope,2,10,10); assert.deepEqual(scroll,[2]); assert.deepEqual(sent,[]);
  scope.term.buffer.active.type='alternate'; routeScrollLines(scope,-2,10,10); assert.equal(sent.pop(),'\x1b[A\x1b[A');
  scope.term.modes.mouseTrackingMode='vt200'; const click=buildMouseClickInput(scope,10,10);
  assert.equal(click,'\x1b[<0;2;2M\x1b[<0;2;2m'); assert.equal(isTerminalGestureInput(click),true);
  routeScrollLines(scope,100,10,10); assert.equal(sent.pop(),'\x1b[<65;2;2M'.repeat(32));
  assert.equal(isTerminalGestureInput('\x1b[A'.repeat(33)),false);
});

test('LiveInput commits only admitted deltas and first cancelled ticket owns rollback', () => {
  const input=new LiveInput(); const tickets=[];
  assert.equal(input.change('g',()=>false),null);
  assert.equal(input.sentText,'');
  assert.equal(input.change('g',(_data,ticket)=>{tickets.push(ticket);return true;}),'g');
  assert.equal(input.change('gi',(_data,ticket)=>{tickets.push(ticket);return true;}),'i');
  tickets[0].cancelled(); tickets[1].cancelled();
  assert.equal(input.sentText,'');
  assert.equal(input.change('git'),'git');
  tickets[1].cancelled(); assert.equal(input.sentText,'git');
});

test('LiveInput dispatched uncertainty survives cancelled suffix but not explicit reset', () => {
  const input=new LiveInput(); const tickets=[];
  input.change('g',(_data,ticket)=>{tickets.push(ticket);return true;});
  input.change('gi',(_data,ticket)=>{tickets.push(ticket);return true;});
  tickets[1].cancelled(); assert.equal(input.sentText,'g');
  tickets[0].uncertain(); assert.equal(input.uncertain,true);
  input.reset(); tickets[0].uncertain();
  assert.equal(input.uncertain,false); assert.equal(input.sentText,'');
});
