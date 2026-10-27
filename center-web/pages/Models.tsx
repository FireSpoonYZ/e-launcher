import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Device, JsonObject, Model } from '@e-launcher/center-contract';
import { api } from '../api';

const blank: Model = { id: '', name: '', contextWindow: 32768, maxTokens: 1024, input: ['text'], reasoning: false, enabled: true, revision: 0 };
export default function Models() {
  const { providerId = '' } = useParams();
  const [models, setModels] = useState<Model[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [discovered, setDiscovered] = useState<Model[]>([]);
  const [edit, setEdit] = useState<Model | null>(null);
  const [creating, setCreating] = useState(false);
  const [advanced, setAdvanced] = useState('{}');
  const [inputTypes, setInputTypes] = useState('text');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const load = async () => { const [m, d] = await Promise.all([api.listModels(providerId), api.listDevices()]); setModels(m); setDevices(d); };
  useEffect(() => { void run(load); }, [providerId]);
  const open = (model: Model, isNew: boolean) => {
    setEdit(model); setCreating(isNew); setInputTypes(model.input.join(', '));
    const { thinkingLevelMap, cost, compat, inputLimits } = model;
    setAdvanced(JSON.stringify({ ...(thinkingLevelMap !== undefined && { thinkingLevelMap }), ...(cost !== undefined && { cost }), ...(compat !== undefined && { compat }), ...(inputLimits !== undefined && { inputLimits }) }, null, 2));
  };
  return <main className="page"><header className="page-header"><h1>{providerId} 的模型</h1><button className="button" onClick={() => open({ ...blank }, true)}>新增模型</button></header><Link to="/providers">返回服务商</Link>{error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="form"><label>从在线设备发现模型<select value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">选择设备</option>{devices.filter(d => d.online).map(d => <option key={d.deviceId} value={d.deviceId}>{d.name || d.deviceId}</option>)}</select></label><button className="button secondary-button" disabled={busy || !deviceId} onClick={() => void run(async () => { const result = await api.discoverModels(providerId, { deviceId }); setDiscovered(result.models); setNotice(`发现 ${result.models.length} 个模型，选择后确认保存。`); })}>发现模型</button></div>
    {discovered.map(model => <article className="resource-row" key={model.id}><strong>{model.name || model.id}</strong><span> · {model.id}</span><button className="quiet-button" disabled={models.some(m => m.id === model.id)} onClick={() => open({ ...model, revision: 0 }, true)}>填写并保存</button></article>)}
    {models.map(model => <article className="resource-row" key={model.id}><h2>{model.name || model.id}</h2><p className="secondary">{model.id} · 上下文 {model.contextWindow} · {model.enabled ? '已启用' : '已停用'}</p><button className="quiet-button" onClick={() => open(model, false)}>编辑</button></article>)}
    {edit && <section className="panel"><h2>{creating ? '新增模型' : '编辑模型'}</h2><form className="form" onSubmit={e => { e.preventDefault(); void run(async () => {
      const extra = JSON.parse(advanced) as JsonObject;
      if (!extra || Array.isArray(extra) || typeof extra !== 'object' || Object.keys(extra).some(k => !['thinkingLevelMap', 'cost', 'compat', 'inputLimits'].includes(k))) throw new Error('高级参数仅接受 thinkingLevelMap、cost、compat、inputLimits 对象');
      const { thinkingLevelMap: _t, cost: _c, compat: _co, inputLimits: _i, ...base } = edit;
      const input = inputTypes.split(',').map(v => v.trim()).filter(Boolean);
      if (!input.length) throw new Error('至少填写一个输入类型');
      const value = { ...base, ...extra, input } as Model;
      const saved = creating ? await api.createModel(providerId, value) : await api.putModel(providerId, edit.id, { expectedRevision: edit.revision, value });
      open(saved, false); await load(); setNotice('模型已保存');
    }); }}>
      <label>模型 ID<input required disabled={!creating} value={edit.id} onChange={e => setEdit({ ...edit, id: e.target.value })} /></label>
      <label>显示名称<input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
      <label>上下文窗口<input type="number" min="1" required value={edit.contextWindow} onChange={e => setEdit({ ...edit, contextWindow: Number(e.target.value) })} /></label>
      <label>最大输出 token<input type="number" min="1" required value={edit.maxTokens} onChange={e => setEdit({ ...edit, maxTokens: Number(e.target.value) })} /></label>
      <label>输入类型（逗号分隔）<input required value={inputTypes} onChange={e => setInputTypes(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={edit.reasoning} onChange={e => setEdit({ ...edit, reasoning: e.target.checked })} />支持推理</label>
      <label className="check"><input type="checkbox" checked={edit.enabled} onChange={e => setEdit({ ...edit, enabled: e.target.checked })} />启用</label>
      <label>高级参数（JSON）<textarea rows={8} value={advanced} onChange={e => setAdvanced(e.target.value)} /></label>
      <div className="action-row"><button className="button" disabled={busy}>保存模型</button><button type="button" className="quiet-button" onClick={() => setEdit(null)}>关闭</button></div>
    </form></section>}
  </main>;
}
