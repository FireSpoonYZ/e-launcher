import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function editorHarness() {
  const slots=[],effects=[],calls=[];let cursor=0;
  const react={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=initial;return[slots[index],next=>slots[index]=typeof next==='function'?next(slots[index]):next];},
    useEffect(effect){const index=cursor++;if(!(index in slots)){slots[index]=true;effects.push(effect);}},
  };
  const native=new Proxy({}, {get:(_,method)=>async args=>{
    calls.push({method,args});
    if(method==='schema')return {fields:[]};
    if(method==='settings')return {sources:{},revision:'global'};
    if(method==='files')return {files:['settings.json']};
    if(method==='readFile')return {source:'{}'};
    if(method==='saveFile')return {source:args.source};
    return {};
  }});
  const {outputText}=ts.transpileModule(readFileSync(new URL('../src/Editor.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});
  const mocks={
    react,'react-router-dom':{useSearchParams:()=>[new URLSearchParams('project=true&file=settings.json')],useNavigate:()=>()=>{}},
    './native':{NativeSettings:native},'./Settings':{},'./components/ui/dialog':{Dialog:'Dialog'},
    './ui':{Header:'Header',Loading:'Loading',SearchField:'SearchField',Section:'Section',ErrorNotice:'ErrorNotice',useBack:()=>()=>{},useText:()=>(_,en)=>en,useAction:()=>({run:fn=>fn()})},
  };
  const module={exports:{}};
  new Function('require','module','exports',outputText)(name=>Object.hasOwn(mocks,name)?mocks[name]:require(name),module,module.exports);
  const render=name=>{cursor=0;return module.exports[name]();};
  const nodes=node=>node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];
  return {calls,render,nodes,async effects(){for(const effect of effects.splice(0))effect();await new Promise(resolve=>setImmediate(resolve));}};
}
test('all Pi parameter requests are global and no workspace selector is rendered',async()=>{
  const h=editorHarness();const tree=h.render('AdvancedPage');await h.effects();
  assert(h.calls.some(call=>call.method==='settings'&&call.args.project===false));
  assert(!h.nodes(tree).some(node=>node.props?.['aria-label']==='Configuration scope'));
});
test('legacy project editor URL still shows and saves explicitly global settings',async()=>{
  const original=globalThis.window;globalThis.window={addEventListener(){},removeEventListener(){}};
  try{
    const h=editorHarness();h.render('EditorPage');await h.effects();
    let tree=h.render('EditorPage');
    const input=h.nodes(tree).find(node=>node.type==='textarea'&&node.props.className==='code-editor');
    input.props.onChange({target:{value:'{"theme":"light"}'}});
    tree=h.render('EditorPage');
    const header=h.nodes(tree).find(node=>node.type==='Header');
    await header.props.actions.props.onClick();
    for(const call of h.calls.filter(call=>['files','readFile','saveFile','saveDraft'].includes(call.method)))assert.equal(call.args.project,false,call.method);
    assert(h.calls.some(call=>call.method==='saveFile'));
  }finally{globalThis.window=original;}
});
