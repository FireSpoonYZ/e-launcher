import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as input from '../src/RemoteTerminal/input.ts';
import * as keys from '../src/RemoteTerminal/orca/terminal-accessory-keys.ts';
import * as repeat from '../src/RemoteTerminal/orca/terminal-accessory-repeat.ts';
import * as presets from '../src/RemoteTerminal/presets.ts';
const require=createRequire(import.meta.url);
const nodes=node=>node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];
function harness(request = async () => {}) {
  const refs=[], states=[], sent=[];
  const react={
    useRef(value){const ref={current:value};refs.push(ref);return ref;},
    useState(value){const index=states.length;states.push(index===3?true:value);return [states[index],next=>states[index]=next];},
    useEffect(){},
  };
  const source=readFileSync(new URL('../src/RemoteTerminal/TerminalView.tsx',import.meta.url),'utf8').replace('  return <main className="rt-terminal">','  inputHandlers = {resetField}; return <main className="rt-terminal">')+'\nexport {TerminalView}; export let inputHandlers;';
  const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
  const mocks={
    react,'react-router-dom':{useNavigate:()=>()=>{}},'./input':input,
    '../ui':{useText:()=>((_zh,en)=>en),Header:'Header',ErrorNotice:'ErrorNotice'},
    './native':{request:async (_host,method,params)=>{sent.push({method,...params}); return request(method,params);}},
    './Presets':{},'./PresetPanel':{Presets:'Presets'},'./presets':presets,
  };
  const module={exports:{}};
  new Function('require','module','exports',outputText)(name=>{
    if(Object.hasOwn(mocks,name))return mocks[name];
    if(name==='react/jsx-runtime')return require(name);
    if(name.startsWith('./orca/'))return {...keys,...repeat};
    return {};
  },module,module.exports);
  const tree=module.exports.TerminalView({hostId:'host',sessionId:'session'});
  // Production ref order: element, field, terminal, fit, live mirror, alive, canSend.
  refs[1].current={value:'draft',setRangeText(replacement,start,end){this.value=this.value.slice(0,start)+replacement+this.value.slice(end);}};
  refs[2].current={modes:{applicationCursorKeysMode:false,bracketedPasteMode:false},_core:{coreService:{kittyKeyboard:{flags:3}}}};
  refs[5].current=true; refs[6].current=true;
  const field=nodes(tree).find(node=>node.type==='textarea'&&node.props.className==='rt-live-input');
  return {field,refs,states,sent,resetField:module.exports.inputHandlers.resetField,preset:nodes(tree).find(node=>node.type==='Presets'),flush:()=>new Promise(resolve=>setImmediate(resolve))};
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
test('exited-session removal stays enabled and xterm unused viewport follows app background',()=>{
  const page=readFileSync(new URL('../src/RemoteTerminal/index.tsx',import.meta.url),'utf8');
  assert.match(page,/disabled={!connected} onClick={\(\) => setConfirm\({kind:'session'/);
  assert.match(page,/session.status === 'exited' \? t\('移除记录','Remove entry'\)/);
  const css=readFileSync(new URL('../src/RemoteTerminal/terminal.css',import.meta.url),'utf8');
  assert.match(css,/\.rt-screen, \.rt-screen \.xterm, \.rt-screen \.xterm:not\(\.allow-transparency\) \.xterm-viewport \{ background-color:var\(--bg\); \}/);
  assert.match(css,/\.rt-screen \{ flex:1;/);
});

const deferred = () => { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const type = (h,text) => { h.refs[1].current.value=text; h.field.props.onInput(); };
const key = (h,name) => h.field.props.onKeyDown({key:name,code:name,nativeEvent:{key:name,code:name,keyCode:0,isComposing:false,ctrlKey:false,altKey:false,shiftKey:false,metaKey:false,repeat:false},preventDefault(){}});
const wire = h => h.sent.filter(item=>item.method==='terminal.send').map(item=>item.data);

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
