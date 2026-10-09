import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as input from '../src/RemoteTerminal/input.ts';
import * as keys from '../src/RemoteTerminal/orca/terminal-accessory-keys.ts';
import * as repeat from '../src/RemoteTerminal/orca/terminal-accessory-repeat.ts';
import * as presets from '../src/RemoteTerminal/presets.ts';
import * as layout from '../src/RemoteTerminal/orca/terminal-accessory-layout.ts';
import * as scaling from '../src/RemoteTerminal/orca/text-scaling.ts';
import * as scales from '../src/RemoteTerminal/orca/terminal-text-scales.ts';
const require=createRequire(import.meta.url);
const nodes=node=>node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];
function harness(request = async () => {}, clipboard = async () => 'paste') {
  const refs=[], states=[], sent=[];
  const react={
    useRef(value){const ref={current:value};refs.push(ref);return ref;},
    useState(value){const index=states.length;states.push(index===3?true:typeof value==='function'?value():value);return [states[index],next=>states[index]=next];},
    useEffect(){},
  };
  const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8').replace('  return <main className="rt-terminal">','  inputHandlers = {resetField,updateViewport,toggleDisplayMode,toggleInputMode,paste,captureDraft,preserveInFlightDraft,composerRefs:{liveComposer,bufferedComposer,inputMode,pastePending},viewportRefs:{requestedDisplayMode,observedDisplayMode,subscribedId}}; return <main className="rt-terminal">')+'\nexport {TerminalView}; export let inputHandlers;';
  const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
  const mocks={
    react,'@capacitor/core':{Capacitor:{isNativePlatform:()=>false}},'react-router-dom':{useNavigate:()=>()=>{}},'./input':input,
    '../ui':{useText:()=>((_zh,en)=>en),Header:'Header',ErrorNotice:'ErrorNotice'},
    './native':{request:async (_host,method,params)=>{sent.push({method,...params}); return request(method,params);}},
    './clipboard':{readTerminalClipboard:clipboard,writeTerminalClipboard:async()=>{}},
    './viewport':{applyGridScale:()=>true,phoneViewport:()=>({cols:50,rows:20})},
    './Presets':{},'./PresetPanel':{Presets:'Presets'},'./presets':presets,'./AccessoryButton':{AccessoryButton:'AccessoryButton'},
  };
  const module={exports:{}};
  new Function('require','module','exports',outputText)(name=>{
    if(Object.hasOwn(mocks,name))return mocks[name];
    if(name==='react/jsx-runtime')return require(name);
    if(name.startsWith('./orca/'))return {...keys,...repeat,...layout,...scaling,...scales};
    return {};
  },module,module.exports);
  const tree=module.exports.TerminalView({hostId:'host',sessionId:'session'});
  // Production ref order: element, field, terminal, fit, live mirror, alive, canSend.
  refs[1].current={value:'draft',setRangeText(replacement,start,end){this.value=this.value.slice(0,start)+replacement+this.value.slice(end);}};
  refs[2].current={modes:{applicationCursorKeysMode:false,bracketedPasteMode:false},_core:{coreService:{kittyKeyboard:{flags:3}}}};
  refs[5].current=true; refs[6].current=true;
  const field=nodes(tree).find(node=>node.type==='textarea'&&node.props.className==='rt-live-input');
  return {tree,field,refs,states,sent,resetField:module.exports.inputHandlers.resetField,handlers:module.exports.inputHandlers,preset:nodes(tree).find(node=>node.type==='Presets'),flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('TerminalView hardware handler emits flags3 release and preserves keypad/shifted physical code',async()=>{
  const h=harness(); h.refs[1].current.value='';
  const native={key:'a',code:'KeyA',keyCode:65,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,isComposing:false,repeat:false};
  let prevented=0;
  const event=e=>({nativeEvent:e,code:e.code,key:e.key,preventDefault(){prevented++;}});
  h.field.props.onKeyDown(event(native)); await h.flush();
  h.field.props.onKeyUp(event(native)); await h.flush();
  assert.equal(prevented,1);
  assert.deepEqual(h.sent.map(item=>item.data),['a','\x1b[97;1:3u']);
  h.refs[2].current._core.coreService.kittyKeyboard.flags=8;
  h.field.props.onKeyDown(event({...native,key:'!',code:'Digit1',shiftKey:true})); await h.flush();
  h.field.props.onKeyDown(event({...native,key:'1',code:'Numpad1'})); await h.flush();
  assert.deepEqual(h.sent.slice(2).map(item=>item.data),['\x1b[49;2u','\x1b[57400u']);
});
test('TerminalView rejects oversized paste/IME locally without changing ownership or draft',async()=>{
  const h=harness();
  let prevented=false;
  h.field.props.onPaste({preventDefault(){prevented=true;},clipboardData:{getData:()=> '中'.repeat(30000)}});
  await h.flush();
  assert.equal(prevented,true); assert.deepEqual(h.sent,[]);
  assert.equal(h.refs[1].current.value,'draft'); assert.equal(h.refs[6].current,true); assert.equal(h.states[3],true);
  h.refs[1].current.value='中'.repeat(30000);
  h.field.props.onInput(); await h.flush();
  assert.deepEqual(h.sent,[]); assert.equal(h.refs[4].current.sentText,'');
  assert.equal(h.refs[1].current.value.length,30000); assert.equal(h.refs[6].current,true);
  let backspacePrevented=false;
  h.field.props.onKeyDown({key:'Backspace',code:'Backspace',nativeEvent:{key:'Backspace',code:'Backspace',isComposing:false,keyCode:8},preventDefault(){backspacePrevented=true;}});
  assert.equal(backspacePrevented,false, 'rejected drafts allow native local editing instead of flushing');
  assert.deepEqual(h.sent,[]);
  // Apply the browser default deletion, then exercise the actual input handler.
  h.refs[1].current.value=h.refs[1].current.value.slice(0,-1); h.field.props.onInput(); await h.flush();
  assert.equal(h.refs[1].current.value.length,29999); assert.deepEqual(h.sent,[]);
  h.refs[1].current.value='好'; h.field.props.onInput(); await h.flush();
  assert.equal(h.sent[0].data,'好');
});
test('exited-session removal stays enabled and xterm unused viewport uses Orca terminal background',()=>{
  const page=readFileSync(new URL('../src/RemoteTerminal/index.tsx',import.meta.url),'utf8');
  assert.match(page,/disabled={!connected} onClick={\(\) => setConfirm\({kind:'session'/);
  assert.match(page,/session.status === 'exited' \? t\('移除记录','Remove entry'\)/);
  const css=readFileSync(new URL('../src/RemoteTerminal/terminal.css',import.meta.url),'utf8');
  assert.match(css,/\.rt-screen, \.rt-screen \.xterm, \.rt-screen \.xterm:not\(\.allow-transparency\) \.xterm-viewport \{ background-color:#1a1b26; \}/);
  assert.match(css,/\.rt-screen \{ flex:1;/);
});

const deferred = () => { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const type = (h,text) => { h.refs[1].current.value=text; h.field.props.onInput(); };
const key = (h,name) => h.field.props.onKeyDown({key:name,code:name,nativeEvent:{key:name,code:name,keyCode:0,isComposing:false,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,repeat:false},preventDefault(){}});
const wire = h => h.sent.filter(item=>item.method==='terminal.send').map(item=>item.data);

const dockButtons = h => [h.preset.props.accessoryKeys].flat().flatMap(nodes).filter(node=>node.type==='AccessoryButton');
const builtInButtons = h => dockButtons(h).filter(node=>keys.TERMINAL_ACCESSORY_KEYS.some(k=>k.id===node.key));

test('TerminalView default dock shows every Orca built-in in canonical order without sticky modifier keys',async()=>{
  const h=harness(); h.refs[1].current.value=''; h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
  const buttons=builtInButtons(h);
  assert.deepEqual(buttons.map(button=>button.key),[
    'escape','tab','enter','shiftTab','space','backspace','delete',
    'arrowUp','arrowDown','arrowLeft','arrowRight',
    'ctrlC','ctrlD','ctrlL','ctrlZ','ctrlR','ctrlA','ctrlE','ctrlW','ctrlU',
  ]);
  assert.deepEqual(buttons.map(button=>button.props.label),keys.TERMINAL_ACCESSORY_KEYS.map(key=>key.accessibilityLabel));
  for(const button of buttons) { button.props.onPress(); await h.flush(); }
  assert.deepEqual(wire(h),[
    '\x1b','\t','\r','\x1b[Z',' ','\x7f','\x1b[3~',
    '\x1b[A','\x1b[B','\x1b[D','\x1b[C',
    '\x03','\x04','\x0c','\x1a','\x12','\x01','\x05','\x17','\x15',
  ]);
});

test('TerminalView built-in taps and holds honor negotiated Kitty and application cursor modes',async()=>{
  const h=harness(); h.refs[1].current.value='';
  const buttons=builtInButtons(h),button=id=>buttons.find(button=>button.key===id);
  h.refs[2].current._core.coreService.kittyKeyboard.flags=1;
  for(const id of ['ctrlC','ctrlD','ctrlL','ctrlZ','ctrlR','ctrlA','ctrlE','ctrlW','ctrlU','shiftTab']) {
    button(id).props.onPress(); await h.flush();
  }
  assert.deepEqual(wire(h),[
    '\x1b[99;5u','\x1b[100;5u','\x1b[108;5u','\x1b[122;5u','\x1b[114;5u',
    '\x1b[97;5u','\x1b[101;5u','\x1b[119;5u','\x1b[117;5u','\x1b[9;2u',
  ]);
  h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
  h.refs[2].current.modes.applicationCursorKeysMode=true;
  for(const id of ['arrowUp','arrowDown','arrowLeft','arrowRight']) { button(id).props.onPress(); await h.flush(); }
  button('arrowUp').props.onHold(); await h.flush(); button('arrowUp').props.onRelease();
  assert.deepEqual(wire(h).slice(10),['\x1bOA','\x1bOB','\x1bOD','\x1bOC','\x1bOA']);
});

test('TerminalView built-in Backspace and Enter keep the existing draft and submit flow',async()=>{
  const h=harness(); h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
  const buttons=builtInButtons(h),button=id=>buttons.find(button=>button.key===id);
  type(h,'ab'); await h.flush();
  button('backspace').props.onPress(); await h.flush();
  assert.equal(h.refs[1].current.value,'a');
  assert.equal(h.refs[4].current.sentText,'a');
  button('enter').props.onPress(); await h.flush();
  assert.equal(h.refs[1].current.value,'');
  assert.deepEqual(wire(h),['ab','\x7f','\r']);
});

test('TerminalView first g rejected while not ready remains a draft; gi sends both characters once',async()=>{
  const h=harness(); h.refs[6].current=false;
  type(h,'g');
  assert.equal(h.refs[4].current.sentText,'');
  h.resetField(); assert.equal(h.refs[1].current.value,'g');
  await h.flush(); assert.deepEqual(wire(h),[]);
  h.refs[6].current=true; type(h,'gi'); await h.flush();
  type(h,'git status'); await h.flush();
  assert.deepEqual(wire(h),['gi','t status']);
});

test('TerminalView first Unicode/IME codepoint rejected before alive is committed once when ready',async()=>{
  const h=harness(); h.refs[5].current=false;
  h.field.props.onCompositionStart(); type(h,'ni'); type(h,'你');
  h.field.props.onCompositionEnd(); await h.flush();
  assert.equal(h.refs[4].current.sentText,''); assert.deepEqual(wire(h),[]);
  h.resetField(); assert.equal(h.refs[1].current.value,'你');
  h.refs[5].current=true; type(h,'你🙂'); h.field.props.onCompositionEnd(); await h.flush();
  assert.deepEqual(wire(h),['你🙂']);
});

test('TerminalView epoch cancellation before dispatch restores first-character mirror without automatic replay',async()=>{
  const h=harness(); type(h,'g'); type(h,'gi');
  h.refs[12].current++; h.resetField();
  assert.equal(h.refs[1].current.value,'gi');
  await h.flush(); assert.deepEqual(wire(h),[]); assert.equal(h.refs[4].current.sentText,'');
  assert.equal(h.refs[1].current.value,'gi');
  type(h,'git'); await h.flush(); assert.deepEqual(wire(h),['git']);
});

test('TerminalView retires old queued first character before recovered input overtakes native ack',async()=>{
  for (const lifecycleReset of [true,false]) {
    const first=deferred(); const h=harness(()=>first.promise); h.refs[1].current.value='';
    key(h,'ArrowUp'); await h.flush();
    type(h,'g');
    h.refs[12].current++; h.refs[6].current=false;
    if (lifecycleReset) h.resetField();
    h.refs[6].current=true; type(h,'gi'); // Recovery and admission precede the old queue drain.
    assert.deepEqual(wire(h),['\x1b[A']);
    assert.equal(h.refs[4].current.sentText,'gi');
    first.resolve(); await h.flush();
    assert.deepEqual(wire(h),['\x1b[A','gi']);
    assert.equal(h.refs[1].current.value,'gi'); assert.equal(h.refs[4].current.sentText,'gi');
    type(h,'git'); await h.flush();
    assert.deepEqual(wire(h),['\x1b[A','gi','t']);
  }
});

test('TerminalView retires queued Enter restoration before recovered typing and old callbacks drain',async()=>{
  const first=deferred(); const h=harness(()=>first.promise); h.refs[1].current.value='';
  key(h,'ArrowUp'); await h.flush();
  type(h,'g'); key(h,'Enter'); type(h,'i');
  h.refs[12].current++; h.refs[6].current=false; h.resetField();
  assert.equal(h.refs[1].current.value,'gi');
  h.refs[6].current=true; type(h,'git');
  first.resolve(); await h.flush();
  assert.deepEqual(wire(h),['\x1b[A','git']);
  assert.equal(h.refs[1].current.value,'git'); assert.equal(h.refs[4].current.sentText,'git');
});

test('TerminalView preserves dispatched prefix uncertainty after synchronous suffix retirement and recovery',async()=>{
  const first=deferred(); const h=harness(()=>first.promise);
  type(h,'g'); await h.flush(); type(h,'gi');
  h.refs[12].current++; h.refs[6].current=false; h.resetField();
  h.refs[6].current=true; type(h,'git');
  first.reject(new Error('native delivery unknown')); await h.flush();
  assert.deepEqual(wire(h),['g']);
  assert.equal(h.refs[1].current.value,'git'); assert.equal(h.refs[4].current.uncertain,true);
  h.refs[6].current=true; type(h,'git '); await h.flush();
  assert.deepEqual(wire(h),['g']);
});

test('TerminalView hardware Meta+Backspace preserves the Kitty binding and acknowledged field',async()=>{
  const h=harness(); type(h,'g'); await h.flush();
  const native={key:'Backspace',code:'Backspace',keyCode:8,isComposing:false,ctrlKey:false,altKey:false,shiftKey:false,metaKey:true,repeat:false};
  let prevented=false;
  h.field.props.onKeyDown({key:native.key,code:native.code,nativeEvent:native,preventDefault(){prevented=true;}});
  await h.flush();
  assert.equal(prevented,true); assert.equal(h.refs[1].current.value,'g');
  assert.deepEqual(wire(h),['g','\x1b[127;9u']);
});

test('TerminalView cancels queued suffix without replaying a prefix already dispatched',async()=>{
  const first=deferred(); const h=harness(()=>first.promise);
  type(h,'g'); await h.flush(); type(h,'gi'); type(h,'git');
  h.refs[12].current++; h.refs[6].current=false; h.resetField();
  first.resolve(); await h.flush();
  assert.deepEqual(wire(h),['g']); assert.equal(h.refs[4].current.sentText,'g');
  assert.equal(h.refs[1].current.value,'git');
  h.refs[6].current=true; type(h,'git '); await h.flush();
  assert.deepEqual(wire(h),['g','it ']);
});

test('TerminalView ambiguous native delivery quarantines draft, including queued suffix, until explicit local clear',async()=>{
  const first=deferred(); const h=harness(()=>first.promise);
  type(h,'g'); await h.flush(); type(h,'gi'); first.reject(new Error('connection lost'));
  await h.flush(); h.resetField();
  assert.deepEqual(wire(h),['g']); assert.equal(h.refs[1].current.value,'gi');
  assert.equal(h.refs[4].current.uncertain,true);
  assert.ok(h.states.some(value=>typeof value==='string' && /delivery is unknown/.test(value)));
  h.refs[6].current=true; type(h,'git'); await h.flush(); assert.deepEqual(wire(h),['g']);
  assert.ok(h.states.some(value=>typeof value==='string' && /delivery is unknown/.test(value)));
  type(h,''); assert.equal(h.refs[4].current.uncertain,false);
});

test('TerminalView rejected admission cannot clear draft through Enter, paste or focused preset',async()=>{
  const h=harness(); h.refs[6].current=false; type(h,'g');
  key(h,'Enter');
  h.field.props.onPaste({preventDefault(){},clipboardData:{getData:()=> ' status'}});
  h.preset.props.send({id:'status',label:'status',kind:'text',text:' status',appendEnter:false});
  await h.flush(); assert.equal(h.refs[1].current.value,'g'); assert.deepEqual(wire(h),[]);
  h.refs[6].current=true;
  h.preset.props.send({id:'status',label:'status',kind:'text',text:' status',appendEnter:false});
  await h.flush(); assert.deepEqual(wire(h),['g',' status']);
  type(h,'x'); await h.flush(); assert.deepEqual(wire(h),['g',' status','x']);
});

test('TerminalView cancelled Enter restores draft ownership and merges later local text without replay',async()=>{
  const h=harness(); type(h,'g'); key(h,'Enter'); type(h,'i');
  h.refs[12].current++; h.resetField(); await h.flush();
  assert.deepEqual(wire(h),[]); assert.equal(h.refs[1].current.value,'gi');
  assert.equal(h.refs[4].current.sentText,'');
  type(h,'git'); await h.flush(); assert.deepEqual(wire(h),['git']);
});

test('TerminalView ordinary arrows, Tab and empty-field Enter remain queued during pending request',async()=>{
  const first=deferred(); const h=harness(()=>first.promise); h.refs[1].current.value='';
  key(h,'ArrowUp'); await h.flush();
  key(h,'ArrowUp'); key(h,'Tab'); key(h,'Enter'); key(h,'Enter');
  first.resolve(); await h.flush();
  assert.deepEqual(wire(h),['\x1b[A','\x1b[A','\t','\r','\r']);
});

test('TerminalView only draft-reset boundaries are held; typing, chord presets and controls still queue',async()=>{
  const first=deferred(); const h=harness(()=>first.promise); h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
  type(h,'g'); await h.flush(); key(h,'Enter'); type(h,'x');
  key(h,'Enter'); // x must not be detached by a second unsettled reset.
  assert.equal(h.refs[1].current.value,'x');
  h.preset.props.send({id:'cancel',label:'Cancel',kind:'chord',chord:{key:'c',modifiers:['ctrl']}});
  key(h,'ArrowDown'); key(h,'Tab'); key(h,'Escape');
  first.resolve(); await h.flush();
  assert.deepEqual(wire(h),['g','\r','x','\x03','\x1b[B','\t','\x1b']);
  assert.equal(h.refs[1].current.value,'x');
});

test('TerminalView independent buffered editing stays local, confirmed live prefix is retired and submit sends once',async()=>{
 const h=harness();h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 type(h,'gi');await h.flush();
 h.handlers.toggleInputMode();type(h,'git status');await h.flush();
 assert.deepEqual(wire(h),['gi']);assert.equal(h.refs[1].current.value,'git status');
 key(h,'Enter');await h.flush();
 assert.deepEqual(wire(h),['gi','git status','\r']);assert.equal(h.refs[1].current.value,'');
 h.handlers.toggleInputMode();type(h,'pwd');await h.flush();assert.equal(wire(h).at(-1),'pwd');
});
test('TerminalView buffered offline draft is retained on submit rejection and delivered after control returns',async()=>{
 const h=harness();h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 h.handlers.toggleInputMode();h.refs[6].current=false;type(h,'你好');
 key(h,'Enter');await h.flush();assert.deepEqual(wire(h),[]);assert.equal(h.refs[1].current.value,'你好');
 h.refs[6].current=true;key(h,'Enter');await h.flush();assert.deepEqual(wire(h),['你好','\r']);
});
test('TerminalView does not switch mirror mode while a draft delivery/submit is pending',async()=>{
 const waiting=deferred(),h=harness(()=>waiting.promise);
 h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 type(h,'g');await h.flush();h.handlers.toggleInputMode();
 type(h,'gi');assert.equal(h.refs[4].current.sentText,'gi','blocked mode switch stays live');
 waiting.resolve();await h.flush();assert.deepEqual(wire(h),['g','i']);
});
test('Paste guards clipboard permission failure and a stale control epoch before dispatch',async()=>{
 const h=harness(async()=>{},async()=>{throw new Error('permission denied');});
 await h.handlers.paste();assert.deepEqual(wire(h),[]);assert.ok(h.states.some(state=>String(state).includes('permission denied')));
 const waiting=deferred(),other=harness(async()=>{},()=>waiting.promise);other.refs[1].current.value='';
 const paste=other.handlers.paste();other.refs[12].current++;waiting.resolve('must not send');
 await paste;await other.flush();assert.deepEqual(wire(other),[]);
});
test('Paste flushes live draft in order, sanitizes bracket markers and never edits or submits buffered draft',async()=>{
 const h=harness(async()=>{},async()=> 'x\x1b[201~y');
 h.refs[2].current.modes.bracketedPasteMode=true;h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 await h.handlers.paste();await h.flush();assert.deepEqual(wire(h),['draft','\x1b[200~xy\x1b[201~']);
 const buffered=harness(async()=>{},async()=> 'text');buffered.refs[1].current.value='';
 buffered.handlers.toggleInputMode();type(buffered,'draft');await buffered.handlers.paste();assert.equal(buffered.refs[1].current.value,'draft');assert.deepEqual(wire(buffered),['text']);
});
test('viewport mode queue never resizes desktop on keyboard/font changes and requires new host support',async()=>{
 const h=harness(async()=>({session:{displayMode:'desktop'},snapshot:{cols:80,rows:24,ansi:'',seq:0}}));h.refs[0].current={};
 // Production seam refs after the original input refs: inFlight, boundary, lease,
 // inputMode, scale, requestedMode, observedMode, chain, generation, subscription.
 const {requestedDisplayMode:requested,observedDisplayMode:observed,subscribedId:subscription}=h.handlers.viewportRefs;
 requested.current='desktop';observed.current='desktop';subscription.current='sub';
 await h.handlers.updateViewport();assert.deepEqual(h.sent,[]);
 requested.current='auto';observed.current=undefined;await h.handlers.updateViewport();assert.deepEqual(h.sent,[]);
 assert.ok(h.states.some(state=>String(state).includes('Update the host')));
 observed.current='desktop';await h.handlers.updateViewport();
 assert.equal(h.sent.at(-1).method,'terminal.displayModeSet');
 assert.deepEqual(h.sent.at(-1).viewport,{cols:50,rows:20});
});

test('displayModeSet reads actual host session metadata and queued auto refit cannot undo explicit desktop',async()=>{
 const pending=deferred(),h=harness(()=>pending.promise);h.refs[0].current={};
 const {requestedDisplayMode:requested,observedDisplayMode:observed,subscribedId:subscription}=h.handlers.viewportRefs;
 observed.current='auto';subscription.current='sub';
 const toggle=h.handlers.toggleDisplayMode();await h.flush();
 assert.equal(h.sent[0].displayMode,'desktop');
 const refit=h.handlers.updateViewport();
 pending.resolve({session:{displayMode:'desktop'},snapshot:{cols:80,rows:24,ansi:'',seq:0}});
 await toggle;await refit;await h.flush();
 assert.equal(requested.current,'desktop');assert.equal(observed.current,'desktop');
 assert.equal(h.sent.length,1,'auto frame measured before toggle completion is stale');
 await h.handlers.updateViewport();assert.equal(h.sent.length,1);
});

test('confirmed live prefix is not replayed by buffered Paste or Submit, and clipboard does not change draft',async()=>{
 const h=harness(async()=>{},async()=> 'clipboard');h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 type(h,'prefix');await h.flush();h.handlers.toggleInputMode();
 assert.equal(h.refs[1].current.value,'');assert.equal(h.refs[4].current.sentText,'');
 type(h,'draft');await h.handlers.paste();
 assert.deepEqual(wire(h),['prefix','clipboard']);assert.equal(h.refs[1].current.value,'draft');
 key(h,'Enter');await h.flush();assert.deepEqual(wire(h),['prefix','clipboard','draft','\r']);
 assert.equal(wire(h).filter(data=>data==='prefix').length,1);
});
test('buffered draft remains independent through mode changes and both native DOM paste and clipboard errors',async()=>{
 const h=harness(async()=>{},async()=>{throw new Error('permission denied');});
 h.refs[1].current.value='';h.handlers.toggleInputMode();type(h,'buffered draft');
 h.handlers.toggleInputMode();assert.equal(h.refs[1].current.value,'');
 const saved=h.handlers.captureDraft(h.refs[1].current);assert.equal(saved.bufferedDraft.value,'buffered draft');assert.equal(saved.live.value,'');
 h.handlers.toggleInputMode();assert.equal(h.refs[1].current.value,'buffered draft');
 await h.handlers.paste();assert.deepEqual(wire(h),[]);assert.equal(h.refs[1].current.value,'buffered draft');
 let prevented=false;
 h.field.props.onPaste({preventDefault(){prevented=true;},clipboardData:{getData:()=> 'event clipboard'}});
 await h.flush();assert.equal(prevented,true);assert.deepEqual(wire(h),['event clipboard']);assert.equal(h.refs[1].current.value,'buffered draft');
});
test('unconfirmed live edits, IME and unknown delivery reject mode change without dropping or flushing text',async()=>{
 for(const state of ['unconfirmed','IME','unknown']) {
   const h=harness();h.refs[1].current.value='unsent';
   if(state==='IME')h.field.props.onCompositionStart();
   if(state==='unknown')h.refs[4].current.uncertain=true;
   h.handlers.toggleInputMode();await h.flush();
   assert.equal(h.handlers.composerRefs.inputMode.current,false,state);
   assert.equal(h.refs[1].current.value,'unsent',state);assert.deepEqual(wire(h),[],state);
   if(state==='unknown')assert.ok(h.states.some(value=>String(value).includes('delivery is unknown')));
 }
});
test('Paste waits for confirmed live flush and ownership loss during that wait cancels clipboard dispatch',async()=>{
 const ack=deferred(),h=harness(()=>ack.promise,async()=> 'clipboard');
 h.refs[1].current.value='';type(h,'pending');await h.flush();
 const paste=h.handlers.paste();await h.flush();assert.deepEqual(wire(h),['pending']);
 h.handlers.toggleInputMode();assert.equal(h.handlers.composerRefs.inputMode.current,false);
 h.refs[6].current=false;h.refs[12].current++;ack.resolve();
 await paste;await h.flush();assert.deepEqual(wire(h),['pending']);assert.equal(h.refs[1].current.value,'pending');
});
test('clipboard read from a retired session cannot dispatch and leaves buffered text intact',async()=>{
 const read=deferred(),h=harness(async()=>{},()=>read.promise);
 h.refs[1].current.value='';h.handlers.toggleInputMode();type(h,'draft');
 const paste=h.handlers.paste();h.refs[5].current=false;h.refs[12].current++;read.resolve('clipboard');
 await paste;assert.deepEqual(wire(h),[]);assert.equal(h.refs[1].current.value,'draft');
 assert.equal(h.handlers.captureDraft(h.refs[1].current).bufferedDraft.value,'draft');
});
test('unknown buffered Paste delivery is never replayed, does not quarantine unsent draft, and later Submit sends only draft',async()=>{
 let fail=true;const h=harness(async()=>{if(fail)throw new Error('lost acknowledgement');},async()=> 'clipboard');
 h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 h.handlers.toggleInputMode();type(h,'draft');await h.handlers.paste();await h.flush();
 assert.deepEqual(wire(h),['clipboard']);assert.equal(h.refs[1].current.value,'draft');assert.equal(h.refs[4].current.uncertain,false);
 assert.ok(h.states.some(value=>String(value).includes('External input delivery is unknown')));
 fail=false;h.refs[6].current=true;key(h,'Enter');await h.flush();
 assert.deepEqual(wire(h),['clipboard','draft','\r']);
});

test('navigation during external Paste preserves buffered draft without inheriting clipboard uncertainty',async()=>{
 const ack=deferred(),h=harness(()=>ack.promise,async()=> 'clipboard');
 h.refs[1].current.value='';h.handlers.toggleInputMode();type(h,'draft');
 const paste=h.handlers.paste();await h.flush();assert.deepEqual(wire(h),['clipboard']);
 h.handlers.preserveInFlightDraft();
 const saved=h.handlers.captureDraft(h.refs[1].current);
 assert.equal(saved.bufferedDraft.value,'draft');assert.equal(saved.bufferedDraft.mirror.uncertain,false);
 h.refs[5].current=false;h.refs[12].current++;ack.reject(new Error('connection closed'));await paste;
 assert.equal(saved.bufferedDraft.value,'draft');assert.equal(saved.bufferedDraft.mirror.uncertain,false);
});
test('navigation during a field-owned live delivery quarantines that mirror rather than replaying it',async()=>{
 const ack=deferred(),h=harness(()=>ack.promise);h.refs[1].current.value='';
 type(h,'pending');await h.flush();h.handlers.preserveInFlightDraft();
 assert.equal(h.refs[4].current.uncertain,true);
 const saved=h.handlers.captureDraft(h.refs[1].current);
 assert.equal(saved.live.value,'pending');assert.equal(saved.live.mirror.change('pending'),null);
 ack.resolve();await h.flush();assert.deepEqual(wire(h),['pending']);
});

test('buffered text macro is external input and does not submit or clear the buffered composer',async()=>{
 const h=harness();h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 h.handlers.toggleInputMode();type(h,'draft');
 h.preset.props.send({id:'macro',label:'Macro',kind:'text',text:'macro',appendEnter:true});await h.flush();
 assert.deepEqual(wire(h),['macro\r']);assert.equal(h.refs[1].current.value,'draft');
 key(h,'Enter');await h.flush();assert.deepEqual(wire(h),['macro\r','draft','\r']);
});
test('ambiguous buffered submission restores later edits and does not resend on recovered Enter',async()=>{
 const ack=deferred(),h=harness(()=>ack.promise);h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 h.handlers.toggleInputMode();type(h,'command');key(h,'Enter');await h.flush();type(h,' later');
 ack.reject(new Error('acknowledgement lost'));await h.flush();
 assert.deepEqual(wire(h),['command']);assert.equal(h.refs[1].current.value,'command later');assert.equal(h.refs[4].current.uncertain,true);
 h.refs[6].current=true;key(h,'Enter');await h.flush();assert.deepEqual(wire(h),['command']);
});

test('explicit buffered clear locally unlocks unknown/rejected composer, allowing switch, Paste and one new command',async()=>{
 let fail=true;const h=harness(async()=>{if(fail)throw new Error('lost acknowledgement');},async()=> 'clipboard');
 h.refs[1].current.value='';h.refs[2].current._core.coreService.kittyKeyboard.flags=0;
 h.handlers.toggleInputMode();type(h,'old command');key(h,'Enter');await h.flush();
 assert.equal(h.refs[4].current.uncertain,true);
 type(h,'nonempty replacement');h.handlers.toggleInputMode();await h.handlers.paste();
 assert.equal(h.refs[4].current.uncertain,true);assert.equal(h.handlers.composerRefs.inputMode.current,true);assert.deepEqual(wire(h),['old command']);
 const untouchedLive=h.handlers.composerRefs.liveComposer.current.mirror;
 type(h,'');await h.flush();assert.equal(h.refs[4].current.uncertain,false);assert.equal(h.handlers.captureDraft(h.refs[1].current).bufferedDraft.rejected,false);
 assert.equal(h.handlers.composerRefs.liveComposer.current.mirror,untouchedLive);assert.deepEqual(wire(h),['old command'],'clear emits no Enter/backspace/PTy bytes');
 h.handlers.toggleInputMode();assert.equal(h.handlers.composerRefs.inputMode.current,false);
 h.handlers.toggleInputMode();fail=false;h.refs[6].current=true;
 await h.handlers.paste();type(h,'new command');key(h,'Enter');await h.flush();
 assert.deepEqual(wire(h),['old command','clipboard','new command','\r']);
});
