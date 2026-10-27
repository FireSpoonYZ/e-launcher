import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CredentialInfo, Device, Provider } from '@e-launcher/center-contract';
import { api, CenterApiError } from '../api';

const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'pi-messages'];
const blank: Provider = { id: '', name: '', api: protocols[0], baseUrl: '', credentialRef: null, enabled: true, revision: 0 };
export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [edit, setEdit] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [credential, setCredential] = useState<CredentialInfo | null>(null);
  const [savedRef, setSavedRef] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const load = async () => { const [p, d] = await Promise.all([api.listProviders(), api.listDevices()]); setProviders(p); setDevices(d); };
  useEffect(() => { void run(load); }, []);
  const open = async (provider: Provider, isNew: boolean) => {
    setEdit(provider); setCreating(isNew); setSecret(''); setCredential(null); setSavedRef(provider.credentialRef); setNotice('');
    if (provider.credentialRef) {
      try { setCredential(await api.getCredential(provider.credentialRef)); }
      catch (e) { if (!(e instanceof CenterApiError && e.status === 404)) throw e; }
    }
  };
  return <main className="page"><header className="page-header"><h1>服务商与模型</h1><button className="button" onClick={() => void run(() => open({ ...blank }, true))}>新增服务商</button></header><Link to="/devices">设置全局与 Bot 模型</Link>{error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {providers.map(provider => <article className="resource-row" key={provider.id}><h2>{provider.name || provider.id}</h2><p className="secondary">{provider.id} · {provider.api} · {provider.enabled ? '已启用' : '已停用'}</p><div className="action-row"><button className="quiet-button" onClick={() => void run(() => open(provider, false))}>编辑</button><Link to={`/providers/${encodeURIComponent(provider.id)}/models`}>模型</Link></div></article>)}
    {edit && <section className="panel"><h2>{creating ? '新增服务商' : '编辑服务商'}</h2><form className="form" onSubmit={event => { event.preventDefault(); void run(async () => { const saved = creating ? await api.createProvider(edit) : await api.putProvider(edit.id, { expectedRevision: edit.revision, value: edit }); await open(saved, false); await load(); setNotice('服务商已保存'); }); }}>
      <label>服务商 ID<input required value={edit.id} disabled={!creating} onChange={e => setEdit({ ...edit, id: e.target.value })} /></label><label>显示名称<input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label><label>Base URL<input type="url" required value={edit.baseUrl} onChange={e => setEdit({ ...edit, baseUrl: e.target.value })} /></label><label>API 协议<select value={edit.api} onChange={e => setEdit({ ...edit, api: e.target.value })}>{!protocols.includes(edit.api) && <option>{edit.api}</option>}{protocols.map(p => <option key={p}>{p}</option>)}</select></label><label>凭证引用<input value={edit.credentialRef || ''} onChange={e => setEdit({ ...edit, credentialRef: e.target.value || null })} /></label><label className="check"><input type="checkbox" checked={edit.enabled} onChange={e => setEdit({ ...edit, enabled: e.target.checked })} />启用</label><div className="action-row"><button className="button" disabled={busy}>保存服务商</button><button type="button" className="quiet-button" onClick={() => { setEdit(null); setSecret(''); }}>关闭</button></div></form>
      {!creating && edit.credentialRef && edit.credentialRef === savedRef && <form className="form" onSubmit={e => { e.preventDefault(); void run(async () => { const result = await api.putCredential(edit.credentialRef!, { value: secret, expectedRevision: credential?.revision ?? null }); setCredential(result); setSecret(''); setNotice('凭证已保存'); }); }}>
        <h3>凭证：{edit.credentialRef}</h3><p className="secondary">{credential?.configured ? '已配置；不会回显密钥' : '尚未配置'}</p>
        <label>新 API Key<input type="password" required autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} /></label>
        <div className="action-row"><button className="button" disabled={busy}>保存凭证</button>{credential?.configured && <button type="button" className="quiet-button danger" disabled={busy} onClick={() => void run(async () => { await api.deleteCredential(edit.credentialRef!, { expectedRevision: credential.revision, value: null }); setCredential(null); setSecret(''); setNotice('凭证已删除'); })}>删除凭证</button>}</div>
      </form>}
      {!creating && <div className="form"><label>用于连接检查的在线设备<select value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">选择设备</option>{devices.filter(d => d.online).map(d => <option key={d.deviceId} value={d.deviceId}>{d.name || d.deviceId}</option>)}</select></label><button className="button secondary-button" disabled={busy || !deviceId} onClick={() => void run(async () => { const result = await api.validateProvider(edit.id, { deviceId }); setNotice(`${result.ok ? '连接成功' : '连接失败'}：${result.message}`); })}>检查连接</button></div>}
    </section>}
  </main>;
}
