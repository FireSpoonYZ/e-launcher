import { LoaderCircle } from 'lucide-react';
import type { ExecutionState } from './native';
import { useText } from './ui';

export function executionLabel(state: ExecutionState|undefined, fallback: string, t: (zh:string,en:string)=>string) {
  const tool = state?.toolName || '';
  switch (state?.phase) {
    case 'thinking': return t('正在思考…','Thinking…');
    case 'responding': return t('正在回复…','Responding…');
    case 'tool': return tool ? t(`正在使用 ${tool}`,`Using ${tool}`) : t('正在使用工具…','Using a tool…');
    case 'retrying': return t('等待重试','Waiting to retry') + (state.attempt ? ` ${state.attempt}${state.maxAttempts ? '/' + state.maxAttempts : ''}` : '')
      + (state.delayMs ? t(` · ${Math.ceil(state.delayMs/1000)} 秒后`,` · in ${Math.ceil(state.delayMs/1000)}s`) : '');
    case 'compacting': return t('正在整理上下文…','Compacting context…');
    case 'waiting_user': return t('等待回答','Waiting for your answer');
    case 'waiting_shower': return t('等待结束 Shower 手动接管','Waiting for Shower hand-back');
    case 'stopping': return t('正在停止…','Stopping…');
    case 'error': return t('执行失败','Run failed');
    case 'interrupted': return t('运行已中断','Run interrupted');
    default: return fallback || t('正在启动…','Starting…');
  }
}
export function ExecutionStatus({execution, fallback=''}: {execution?: ExecutionState; fallback?: string}) {
  const t = useText();
  const waiting = execution?.phase?.startsWith('waiting_');
  return <div className="run-status" role="status" data-phase={execution?.phase}><LoaderCircle className={waiting ? '' : 'spin'} aria-hidden="true"/>{executionLabel(execution, fallback, t)}</div>;
}
export function RecoveryNotice({prepared, disabled, onPrepare, onHistory}: {prepared:boolean; disabled:boolean; onPrepare():void; onHistory():void}) {
  const t = useText();
  return <div className="archive-banner" role="status">
    <p>{t('运行已中断。外部操作可能已完成，请勿直接重发原请求。','The run was interrupted. External actions may already have completed. Avoid resending the original request.')}</p>
    {prepared && <small>{t('上下文已准备好。请输入新的要求并手动发送；下一次请求会要求模型先只读检查当前状态。','Context is ready. Enter new instructions and send manually; the next request asks the model to inspect current state read-only.')}</small>}
    <div className="archive-banner-actions">{!prepared && <button className="button" disabled={disabled} onClick={onPrepare}>{t('准备续接','Prepare continuation')}</button>}<button className="quiet-button" onClick={onHistory}>{t('查看历史','Review history')}</button></div>
  </div>;
}
