import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { Dialog, ConfirmDialog } from './components/ui/dialog';
import { ErrorNotice, Header, Row, query, useAction, useText } from './ui';
import { type QueryOperation } from './native';
import { Toggle } from './Settings';
import { LoginFlow } from './Resources';

type Server = {name:string;scope:'global'|'project';source:string;enabled:boolean;exposure:string;transport:string;state:string;checkedAt?:number;tools?:{name:string;description?:string}[];error?:string};
type Listing = {servers:Server[];errors:string[];chatNote?:string;revisions:Record<string,string>};
export function McpPage() {
  const t=useText(), action=useAction(), nav=useNavigate();
  const [list,setList]=useState<Listing>(),[edit,setEdit]=useState<{name:string;scope:string;revision:string;definition:Record<string,any>}>();
  const [selected,setSelected]=useState<Server>(),[remove,setRemove]=useState<Server>(),[login,setLogin]=useState<Server>();
  const probe=useRef<AbortController|null>(null);
  const select=(server?:Server)=>{probe.current?.abort();probe.current=null;setSelected(server);};
  useEffect(()=>()=>{probe.current?.abort();probe.current=null;},[]);
  const project=false;
  const load=async()=>setList(await query<Listing>('mcp_list'));
  useEffect(()=>{void action.run(load);},[]);
  const operate=async(type:QueryOperation,server:Server,extra={})=>query(type,{name:server.name,scope:server.scope,revision:list?.revisions[server.scope],...extra});
  const check=(server:Server)=>action.run(async()=>{
    probe.current?.abort();const controller=new AbortController();probe.current=controller;
    try{
      const checked=await query<Partial<Server>>('mcp_check',{name:server.name,scope:server.scope},undefined,controller.signal);
      if(controller.signal.aborted||probe.current!==controller)return;
      const next={...server,...checked};setSelected(next);
      setList(old=>old&&({...old,servers:old.servers.map(s=>s.name===server.name&&s.scope===server.scope?next:s)}));
    }catch(error){if(!controller.signal.aborted)throw error;}
    finally{if(probe.current===controller)probe.current=null;}
  });
  return <main className="page"><Header title="MCP" actions={<><button className="icon-button" aria-label={t('刷新配置','Refresh configuration')} disabled={action.busy} onClick={()=>action.run(load)}><RefreshCw/></button><button className="icon-button" aria-label={t('新增服务器','Add server')} disabled={!list||action.busy} onClick={()=>setEdit({name:'',scope:project?'project':'global',revision:list!.revisions[project?'project':'global'],definition:{url:'',exposure:'codemode'}})}><Plus/></button></>}/>
    <p className="secondary">{t('连接真实 stdio / Streamable HTTP MCP 服务器，不支持旧 SSE。检查状态仅代表最近一次检查，检查后连接会释放；聊天发送时重新连接。','Real stdio / Streamable HTTP MCP servers; legacy SSE is unsupported. Status reflects only the last check; probes close their connections and chat reconnects.')}</p>
    <ErrorNotice error={list?.chatNote}/><Row title={t('编辑完整 MCP 配置文件','Edit full MCP configuration')} detail="mcp.json" onClick={()=>nav(`/settings/editor?file=mcp.json&project=${project}`)}/><ErrorNotice error={action.error}/>{list?.errors.map((e,i)=><ErrorNotice key={i} error={e}/>)}
    {list?.servers.filter(s=>s.scope===(project?'project':'global')).map(server=><Row key={server.name} title={server.name} detail={`${server.transport} · ${server.exposure} · ${server.state}\n${server.source}`}><button className="quiet-button" onClick={()=>select(server)}>{t('管理','Manage')}</button><Toggle label={server.name} checked={server.enabled} disabled={action.busy} onChange={enabled=>action.run(async()=>{await operate('mcp_toggle',server,{enabled});await load();})}/></Row>)}
    <Dialog open={!!selected} title={selected?.name||'MCP'} onOpenChange={v=>!v&&select()}>
      {selected&&<><p className="secondary">{selected.scope} · {selected.source}</p><p role="status">{selected.state}{selected.checkedAt&&` · ${new Date(selected.checkedAt).toLocaleString()}`}</p><ErrorNotice error={selected.error}/><ErrorNotice error={action.error}/>
      <Row title={t('检查 / 重连并读取工具','Check / reconnect and list tools')} onClick={()=>check(selected)}/>
      <Row title={t('编辑服务器（可能显示凭据）','Edit server (may reveal credentials)')} onClick={()=>action.run(async()=>{const data=await operate('mcp_edit',selected) as {config:Record<string,any>;revision:string};setEdit({name:selected.name,scope:selected.scope,revision:data.revision,definition:data.config});select();})}/>
      {selected.transport==='http'&&<><Row title={t('OAuth 登录','OAuth sign in')} onClick={()=>{setLogin(selected);select();}}/><Row title={t('退出 OAuth','OAuth sign out')} onClick={()=>action.run(async()=>{await operate('mcp_logout',selected);select();await load();})}/></>}
      <Row title={t('删除服务器','Delete server')} onClick={()=>setRemove(selected)}/>
      {selected.tools?.map(tool=><Row key={tool.name} title={tool.name} detail={tool.description}/>)}</>}
    </Dialog>
    {edit&&<McpForm value={edit} close={()=>setEdit(undefined)} saved={async()=>{setEdit(undefined);await load();}}/>}
    <ConfirmDialog open={!!remove} title={t('删除服务器？','Delete server?')} description={remove?.name||''} danger onCancel={()=>setRemove(undefined)} onConfirm={()=>action.run(async()=>{const server=remove!;setRemove(undefined);await operate('mcp_remove',server);select();await load();})}/>
    {login&&<LoginFlow provider={{id:login.name,name:login.name,models:[],auth:{},authMethods:[]}} method="oauth" operation="mcp_login" arguments_={{name:login.name,scope:login.scope}} close={()=>{setLogin(undefined);void action.run(load);}}/>}
  </main>;
}
function McpForm({value,close,saved}:{value:{name:string;scope:string;revision:string;definition:Record<string,any>};close():void;saved():Promise<void>}) {
  const t=useText(),action=useAction(),[name,setName]=useState(value.name),[json,setJson]=useState(JSON.stringify(value.definition,null,2));
  const [transport,setTransport]=useState(value.definition.command!==undefined?'stdio':'http'),[endpoint,setEndpoint]=useState(value.definition.url??value.definition.command??''),[args,setArgs]=useState(JSON.stringify(value.definition.args??[])),[exposure,setExposure]=useState(value.definition.exposure??'codemode'),[enabled,setEnabled]=useState(value.definition.enabled!==false);
  return <Dialog open title={t('MCP 服务器','MCP server')} onOpenChange={v=>!v&&close()}><form className="form" onSubmit={e=>{e.preventDefault();void action.run(async()=>{
    const definition=JSON.parse(json);
    if(transport==='http'){delete definition.command;delete definition.args;definition.url=endpoint;}
    else {delete definition.url;definition.command=endpoint;definition.args=JSON.parse(args);}
    definition.type=transport;definition.exposure=exposure;definition.enabled=enabled;
    await query('mcp_save',{name,scope:value.scope,revision:value.revision,definition});await saved();
  });}}>
    <label>{t('名称','Name')}<input required pattern="[A-Za-z0-9_-]+" disabled={!!value.name} value={name} onChange={e=>setName(e.target.value)}/></label>
    <p className="secondary">{value.scope}</p><label>{t('传输','Transport')}<select value={transport} onChange={e=>setTransport(e.target.value)}><option value="http">Streamable HTTP</option><option value="stdio">stdio</option></select></label>
    <label>{transport==='http'?'URL':'Command'}<input required value={endpoint} onChange={e=>setEndpoint(e.target.value)}/></label>
    {transport==='stdio'&&<label>Args (JSON array)<input value={args} onChange={e=>setArgs(e.target.value)}/></label>}
    <label>{t('工具可见性','Tool exposure')}<select value={exposure} onChange={e=>setExposure(e.target.value)}><option value="codemode">codemode · 脚本发现并调用</option><option value="direct">direct · 直接提供给模型</option><option value="deferred">deferred · 工具搜索后提供</option><option value="hidden">hidden · 不可调用</option></select></label>
    <Toggle label={t('启用','Enabled')} checked={enabled} onChange={setEnabled}/>
    <label>{t('高级 JSON（env / headers / oauth / timeout / cwd）','Advanced JSON (env / headers / oauth / timeout / cwd)')}<textarea rows={9} autoComplete="off" spellCheck={false} value={json} onChange={e=>setJson(e.target.value)}/></label>
    <p className="secondary">{t('上面的基础字段优先；其他 JSON 字段原样保留。只运行可信服务器。','Basic fields above take precedence; other JSON fields are preserved. Run only trusted servers.')}</p><ErrorNotice error={action.error}/><button className="button" disabled={action.busy}>{t('保存','Save')}</button>
  </form></Dialog>;
}
