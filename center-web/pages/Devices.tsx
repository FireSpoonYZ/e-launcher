import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotModelConfig, BotRef, Device, ModelConfig, ModelSelection, Provider } from '@e-launcher/center-contract';
import { api } from '../api';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
interface ModelOption { ref: string; name: string }
function SelectionForm({ value, inherited, options, busy, save }: { value: ModelSelection; inherited?: ModelSelection; options: ModelOption[]; busy: boolean; save(value: ModelSelection): void }) {
  const [draft, setDraft] = useState<ModelSelection>(value);
  useEffect(() => setDraft(value), [value]);
  const update = (key: keyof ModelSelection, next: string) => {
    const copy = { ...draft };
    if (next === '__inherit') delete copy[key];
    else copy[key] = next === '__null' ? null : next;
    setDraft(copy);
  };
  const selected = (key: keyof ModelSelection) => draft[key] === undefined ? '__inherit' : draft[key] === null ? '__null' : draft[key]!;
  const modelRef = selected('modelRef');
  const level = selected('thinkingLevel');
  return <form className="form" onSubmit={e => { e.preventDefault(); save(draft); }}>
    {inherited && <p className="secondary">继承全局：{inherited.modelRef ?? '未选择模型'} · 思考档位 {inherited.thinkingLevel ?? '未设置'}</p>}
    <label>模型<select value={modelRef} onChange={e => update('modelRef', e.target.value)}>
      <option value="__inherit">{inherited ? '继承全局' : '未设置'}</option><option value="__null">显式清空</option>
      {modelRef !== '__inherit' && modelRef !== '__null' && !options.some(o => o.ref === modelRef) && <option value={modelRef}>{modelRef}（不可用）</option>}
      {options.map(o => <option key={o.ref} value={o.ref}>{o.name} · {o.ref}</option>)}
    </select></label>
    <label>思考档位<select value={level} onChange={e => update('thinkingLevel', e.target.value)}>
      <option value="__inherit">{inherited ? '继承全局' : '未设置'}</option><option value="__null">显式清空</option>
      {level !== '__inherit' && level !== '__null' && !levels.includes(level) && <option value={level}>{level}</option>}
      {levels.map(v => <option key={v} value={v}>{v}</option>)}
    </select></label><button className="button" disabled={busy}>保存</button>
  </form>;
}
export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [bots, setBots] = useState<Record<string, BotRef[]>>({});
  const [global, setGlobal] = useState<ModelConfig>();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<{ device: Device; bot: BotRef; config: BotModelConfig }>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const load = async () => {
    const [d, g, providers] = await Promise.all([api.listDevices(), api.getModelConfig(), api.listProviders()]);
    const [botLists, modelLists] = await Promise.all([Promise.all(d.map(device => api.listBots(device.deviceId))), Promise.all(providers.map((p: Provider) => api.listModels(p.id)))]);
    setDevices(d); setGlobal(g); setBots(Object.fromEntries(d.map((device, i) => [device.deviceId, botLists[i]])));
    setOptions(modelLists.flatMap((models, i) => providers[i].enabled ? models.filter(m => m.enabled).map(m => ({ ref: `${providers[i].id}/${m.id}`, name: m.name })) : []));
  };
  useEffect(() => { void run(load); }, []);
  return <main className="page"><header className="page-header"><h1>设备与 Bot 模型</h1><button className="quiet-button" disabled={busy} onClick={() => void run(load)}>刷新</button></header>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {global && <section className="panel"><h2>全局模型</h2><SelectionForm value={global.global} options={options} busy={busy} save={value => void run(async () => { setGlobal(await api.putModelConfig({ expectedRevision: global.revision, value })); setNotice('全局模型已保存'); if (selected) setSelected({ ...selected, config: await api.getBotModelConfig(selected.device.deviceId, selected.bot.botId) }); })} /></section>}
    {devices.map(device => <section className="resource-row" key={device.deviceId}><h2>{device.name || device.deviceId}</h2><p className="secondary">{device.deviceId} · {device.online ? '在线' : '离线'}</p>
      {(bots[device.deviceId] || []).map(bot => <div className="bot-row" key={bot.botId}><strong>{bot.name || bot.botId}</strong><span className="secondary">{bot.botId}</span><div className="action-row"><button className="quiet-button" disabled={busy} onClick={() => void run(async () => { setSelected({ device, bot, config: await api.getBotModelConfig(device.deviceId, bot.botId) }); })}>模型配置</button><Link to={`/devices/${encodeURIComponent(device.deviceId)}/bots/${encodeURIComponent(bot.botId)}/capabilities`}>能力分配</Link></div></div>)}
      {!bots[device.deviceId]?.length && <p className="secondary">暂无已登记 Bot</p>}
    </section>)}
    {selected && <section className="panel"><h2>{selected.bot.name || selected.bot.botId} 的模型覆盖</h2><p className="secondary">当前有效模型：{selected.config.effective.modelRef ?? '未选择'} · 思考档位 {selected.config.effective.thinkingLevel ?? '未设置'}</p><SelectionForm value={selected.config.overrides} inherited={selected.config.global} options={options} busy={busy} save={value => void run(async () => { const config = await api.putBotModelConfig(selected.device.deviceId, selected.bot.botId, { expectedRevision: selected.config.revision, value }); setSelected({ ...selected, config }); setNotice('Bot 模型覆盖已保存'); })} /><button className="quiet-button" onClick={() => setSelected(undefined)}>关闭</button></section>}
  </main>;
}
