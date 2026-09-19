/** Host-side one-way projection. Keep this on the host: never transmit raw core state to WebView. */
function scheduleLabel(s){const hm=`${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')}`;
  if(s.kind==='daily')return `每天 ${hm}`;
  if(s.kind==='weekly')return `每周 ${s.weekdays.join('、')} · ${hm}`;
  if(s.kind==='monthly')return `每月 ${s.day} 日 · ${hm}`;
  if(s.kind==='interval')return `每 ${s.intervalMinutes} 分钟`;
  return '自定义计划';
}
/** presentation is trusted host data (avatar/activity/assistant display text), never model tool arguments. */
export function projectPublicUi(state,{revision=state.revision,presentation={},assistantMessages=[],routineTimes={}}={}) {
  if(state.version!==1)throw new Error('Unsupported session state');
  const bots=Object.values(state.sessions).filter(s=>!s.deleted).map(s=>{
    const p=presentation[s.id]??{};
    const running=Object.values(state.runs).some(r=>r.sessionId===s.id&&r.status==='running');
    return {id:s.id,name:s.name,description:s.description,rolePrompt:s.rolePrompt,revision:s.revision,archived:s.archived,
      modelLabel:s.selection?.model??'默认模型',activity:p.activity??(running?'working':'idle'),needsUser:!!p.needsUser,
      avatar:p.avatar?{shape:p.avatar.shape,color:p.avatar.color}:undefined,unread:p.unread??0};
  });
  const alive=new Set(bots.map(b=>b.id));
  const messages=Object.values(state.deliveries).filter(d=>alive.has(d.envelope.toSessionId)||(d.envelope.origin.kind==='bot'&&alive.has(d.envelope.origin.sessionId))).map(d=>{
    const e=d.envelope,o=e.origin;
    const source=o.kind==='user'?{kind:'user'}:o.kind==='bot'?{kind:'bot',sessionId:o.sessionId,name:o.name}:o.kind==='routine'?{kind:'routine',routineId:o.routineId,name:o.name}:null;
    if(!source)throw new Error('Unknown message origin');
    return {id:e.id,toSessionId:e.toSessionId,source,body:e.body,createdAt:e.createdAt,status:d.status,chainId:e.chainId,replyToMessageId:e.replyToMessageId};
  });
  for(const a of assistantMessages){if(!alive.has(a.sessionId))continue;
    messages.push({id:a.id,toSessionId:a.sessionId,source:{kind:'assistant',sessionId:a.sessionId,name:state.sessions[a.sessionId].name},body:a.body,createdAt:a.createdAt,status:'completed'});
  }
  const routines=Object.values(state.routines).filter(r=>alive.has(r.ownerSessionId)).map(r=>({id:r.id,ownerSessionId:r.ownerSessionId,title:r.title,prompt:r.prompt,revision:r.revision,enabled:r.enabled,
    scheduleLabel:scheduleLabel(r.schedule),timeZone:r.schedule.timeZone,nextRunAt:routineTimes[r.id]?.nextRunAt??null,lastStatus:routineTimes[r.id]?.lastStatus??null}));
  return {version:1,revision,bots,messages,routines};
}
