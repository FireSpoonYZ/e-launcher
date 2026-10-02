import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function source(path,mocks,extra='') {
  const {outputText}=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8')+extra,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }});
  const module={exports:{}};
  new Function('require','module','exports',outputText)(name=>Object.hasOwn(mocks,name)?mocks[name]:require(name),module,module.exports);
  return module.exports;
}
test('MCP resource route opens server management rather than extension installation',()=>{
  const McpPage=()=>null;
  const {ResourcesPage}=source('../src/Resources.tsx',{
    react:{useState:()=>[undefined,()=>{}],useEffect:()=>{},useRef:()=>({current:null})},
    'react-router-dom':{useParams:()=>({kind:'mcp'}),useNavigate:()=>()=>{}},
    './native':{},'./Settings':{},'./Mcp':{McpPage},'./components/ui/dialog':{},
    './ui':{useText:()=>(_,en)=>en,useAction:()=>({})},
  });
  assert.equal(ResourcesPage().type,McpPage);
});
test('MCP server form saves native scope/revision with advanced JSON preserved and typed args',async()=>{
  for(const transport of ['http','stdio']) {
    const writes=[],pending=[];
    let state=0,saved=0;
    const overrides=['fixture',JSON.stringify({env:{KEY:'fixture-secret'},oauth:{clientId:'fixture-client'},unknown:{keep:1}}),
      transport,transport==='http'?'https://example.test/mcp':'node','["server.cjs","a b"]','deferred',false];
    const {McpForm}=source('../src/Mcp.tsx',{
      react:{useState:()=>[overrides[state++],()=>{}],useEffect:()=>{}},
      'react-router-dom':{useNavigate:()=>()=>{}},
      './native':{},'./Resources':{},'./Settings':{},'./components/ui/dialog':{},
      './ui':{useText:()=>(_,en)=>en,useAction:()=>({run:fn=>pending.push(fn())}),query:async(...args)=>writes.push(args)},
    },'\nexport { McpForm };');
    const dialog=McpForm({value:{name:'fixture',scope:'global',revision:'rev-1',definition:{}},close:()=>{},saved:async()=>saved++});
    dialog.props.children.props.onSubmit({preventDefault(){}});
    await Promise.all(pending);
    const [operation,args]=writes[0];
    assert.equal(operation,'mcp_save');assert.equal(args.scope,'global');assert.equal(args.revision,'rev-1');
    assert.equal(args.definition.env.KEY,'fixture-secret');assert.equal(args.definition.unknown.keep,1);
    assert.equal(args.definition.exposure,'deferred');assert.equal(args.definition.enabled,false);
    if(transport==='stdio')assert.deepEqual(args.definition.args,['server.cjs','a b']);
    else assert.equal(args.definition.url,'https://example.test/mcp');
    assert.equal(saved,1);
  }
});

function pageHarness(failureOperation) {
  const a={name:'a',scope:'global',source:'mcp.json',enabled:true,exposure:'codemode',transport:'http',state:'unchecked'};
  const b={...a,name:'b'};
  const slots=[],effects=[],requests=[];let cursor=0;
  const action={error:'',busy:false,async run(fn){action.error='';try{return await fn();}catch(error){action.error=error.message;}}};
  const react={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},
    useRef(initial){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
    useEffect(fn){const index=cursor++;if(!(index in slots)){slots[index]=true;effects.push(fn);}},
  };
  const {McpPage}=source('../src/Mcp.tsx',{
    react,'react-router-dom':{useNavigate:()=>()=>{}},'./native':{},'./Resources':{},'./Settings':{},
    './components/ui/dialog':{Dialog:'Dialog',ConfirmDialog:'ConfirmDialog'},
    './ui':{Header:'Header',Row:'Row',Scope:'Scope',ErrorNotice:'ErrorNotice',useText:()=>(_,en)=>en,useAction:()=>action,
      query(operation,args,_events,signal){
        if(operation==='mcp_list')return Promise.resolve({servers:[a,b],errors:[],revisions:{global:'old'}});
        if(operation===failureOperation)return Promise.reject(Error(operation==='mcp_remove'?'stale-delete':'logout-error'));
        return new Promise(resolve=>requests.push({operation,args,signal,resolve}));
      }},
  });
  const render=()=>{cursor=0;return McpPage();};
  const nodes=node=>node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];
  const find=(tree,type,predicate=()=>true)=>nodes(tree).find(node=>node.type===type&&predicate(node.props));
  let tree=render();
  const cleanups=effects.map(effect=>effect());
  return {a,b,requests,render,find,nodes,async ready(){await new Promise(resolve=>setImmediate(resolve));return render();},
    manage(tree,name){find(tree,'button',props=>props.children==='Manage'&&props.onClick).props.onClick();
      if(name==='b')nodes(tree).filter(node=>node.type==='button'&&node.props.children==='Manage')[1].props.onClick();},
    dispose(){for(const cleanup of cleanups)cleanup?.();}};
}
test('MCP stale delete and logout failures remain visible inside the management modal',async()=>{
  for(const operation of ['mcp_remove','mcp_logout']){
    const h=pageHarness(operation);let tree=await h.ready();h.manage(tree,'a');tree=h.render();
    const dialog=h.find(tree,'Dialog');
    if(operation==='mcp_remove'){
      h.find(dialog,'Row',props=>props.title==='Delete server').props.onClick();tree=h.render();
      await h.find(tree,'ConfirmDialog').props.onConfirm();
      tree=h.render();assert.equal(h.find(tree,'ConfirmDialog').props.open,false);
    }else await h.find(dialog,'Row',props=>props.title==='OAuth sign out').props.onClick();
    tree=h.render();
    assert(h.nodes(h.find(tree,'Dialog')).some(node=>node.type==='ErrorNotice'&&node.props.error===(operation==='mcp_remove'?'stale-delete':'logout-error')));
    h.dispose();
  }
});
test('MCP delayed probes cannot reopen dismissed selection, replace another server or survive unmount',async()=>{
  for(const finish of ['dismiss','switch','unmount']){
    const h=pageHarness();let tree=await h.ready();h.manage(tree,'a');tree=h.render();
    const dialog=h.find(tree,'Dialog');
    const pending=h.find(dialog,'Row',props=>props.title==='Check / reconnect and list tools').props.onClick();
    assert.equal(h.requests[0].args.name,'a');
    if(finish==='dismiss')dialog.props.onOpenChange(false);
    if(finish==='switch')h.manage(tree,'b');
    if(finish==='unmount')h.dispose();
    assert(h.requests[0].signal.aborted);
    h.requests[0].resolve({state:'connected',checkedAt:1});
    await pending;tree=h.render();
    const current=h.find(tree,'Dialog');
    if(finish==='dismiss')assert.equal(current.props.open,false);
    if(finish==='switch')assert.equal(current.props.title,'b');
    if(finish==='unmount')assert(!h.nodes(current).some(node=>node.props?.children==='connected'));
    h.dispose();
  }
});
