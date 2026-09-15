import { createContext, useContext, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight, CircleAlert, LoaderCircle, Search } from 'lucide-react';
import { Device, NativeSettings, type DeviceState, type NativeEvent, type QueryOperation } from './native';

export const Environment = createContext<{device?: DeviceState; refresh(): Promise<void>}>({refresh: async () => {}});
export function useText() {
  const { device } = useContext(Environment);
  const en = device?.language === 'en' || (device?.language === 'system' && navigator.language.startsWith('en'));
  return (zh: string, english: string) => en ? english : zh;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const array = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
export function useAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setError(''); setBusy(true);
    try { return await operation(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return {error, setError, busy, run};
}
export function useBack() {
  const navigate = useNavigate(); const location = useLocation();
  return () => {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else if (location.pathname.startsWith('/settings/') && location.pathname !== '/settings') navigate('/settings', {replace: true});
    else if (location.pathname.startsWith('/schedules/')) navigate('/schedules', {replace: true});
    else if (location.pathname.startsWith('/history/') || location.pathname === '/schedules') navigate('/chat', {replace: true});
    else void Device.close();
  };
}
export function Header({title, actions, onBack}: {title: string; actions?: ReactNode; onBack?(): void}) {
  const back = useBack(); const t = useText();
  return <header className="page-header"><button className="icon-button" aria-label={t('返回','Back')} onClick={onBack ?? back}><ArrowLeft/></button><h1>{title}</h1><div className="header-actions">{actions}</div></header>;
}
export function ErrorNotice({error}: {error?: string}) { return error ? <div className="inline-error" role="alert"><CircleAlert/><span>{error}</span></div> : null; }
export function Loading() { const t = useText(); return <div className="loading" role="status"><LoaderCircle className="spin"/>{t('正在加载…','Loading…')}</div>; }
export function Empty({children}: {children: ReactNode}) { return <div className="empty">{children}</div>; }
export function Section({title, children}: {title: string; children: ReactNode}) { return <section className="settings-group"><h2>{title}</h2>{children}</section>; }
export function Row({icon, title, detail, onClick, children}: {icon?: ReactNode; title: string; detail?: string; onClick?(): void; children?: ReactNode}) {
  const content = <>{icon}<span className="row-copy"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>{children ?? (onClick && <ChevronRight className="chevron"/>)}</>;
  return onClick ? <button className="settings-row" onClick={onClick}>{content}</button> : <div className="settings-row">{content}</div>;
}
export function SearchField({value, onChange, placeholder}: {value: string; onChange(value: string): void; placeholder: string}) {
  return <label className="search-field"><Search/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/></label>;
}
export function Scope({project, onChange}: {project: boolean; onChange(value: boolean): void}) { const t = useText(); return <div className="segments scope" aria-label={t('配置作用域','Configuration scope')}><button aria-pressed={!project} onClick={() => onChange(false)}>{t('全局','Global')}</button><button aria-pressed={project} onClick={() => onChange(true)}>{t('工作区','Workspace')}</button></div>; }

// Subscribe first. Buffered events belong to this returned request ID, including fast completions.
export async function query<T>(operation: QueryOperation, args: Record<string, unknown> = {}, onEvent?: (event: NativeEvent) => void): Promise<T> {
  let id: string | undefined; const buffered: NativeEvent[] = [];
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const done = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  let result: T, failure = '';
  const receive = (event: NativeEvent) => {
    if (!id) { buffered.push(event); return; }
    if (event.id !== id) return;
    onEvent?.(event);
    if (event.type === 'result') result = event.result as T;
    if (event.type === 'error') failure = String(event.message ?? 'Operation failed');
    if (event.type === 'end') {
      if (failure || event.status !== 'completed') reject(new Error(failure || String(event.status)));
      else resolve(result);
    }
  };
  const listener = await NativeSettings.addListener('settingsEvent', receive);
  try {
    id = (await NativeSettings.query({operation, arguments: args})).requestId;
    buffered.forEach(receive);
    return await done;
  } finally { await listener.remove(); }
}
