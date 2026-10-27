import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Form from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import type { RJSFSchema } from '@rjsf/utils';
import type { BotRef, DeploymentReceipt, Device, Installation as InstallationDto, InstallationConfig, JsonSchema, JsonValue, PackageVersion, CapabilityTool } from '@e-launcher/center-contract';
import { api } from '../api';
import ConfigForm from '../components/ConfigForm';
import { ConfigOperation, errorMessage } from '../components/ConfigOperation';
import '../components/Config.css';

type ActionDescriptor = { id: string; title: string; inputSchema: JsonSchema; outputSchema?: JsonSchema };
const validator = customizeValidator({ customFormats: { 'credential-ref': /.*/ } });
export default function Installation() {
  const { installationId = '' } = useParams();
  const [item, setItem] = useState<InstallationDto>(), [config, setConfig] = useState<InstallationConfig>(), [receipts, setReceipts] = useState<DeploymentReceipt[]>([]), [devices, setDevices] = useState<Device[]>([]), [bots, setBots] = useState<(BotRef & { enabled: boolean })[]>([]), [actions, setActions] = useState<ActionDescriptor[]>([]), [versions, setVersions] = useState<PackageVersion[]>([]);
  const [artifact, setArtifact] = useState<File>(), [tools, setTools] = useState<CapabilityTool[]>(), [flow, setFlow] = useState<{ flowId: string; authorizationUrl: string }>(), [flowStatus, setFlowStatus] = useState('');
  const [tab, setTab] = useState('概览'), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [operation, setOperation] = useState(''), [version, setVersion] = useState(''), [deviceId, setDeviceId] = useState(''), [botId, setBotId] = useState(''), [action, setAction] = useState(''), [result, setResult] = useState<JsonValue>();
  const load = async () => {
    try {
      const [installation, nextConfig, deployments, nextDevices, descriptors] = await Promise.all([api.getInstallation(installationId), api.getInstallationConfig(installationId), api.listDeployments(installationId), api.listDevices(), api.listActions(installationId)]);
      setItem(installation); setConfig(nextConfig); setReceipts(deployments); setDevices(nextDevices); setActions(descriptors); setError('');
    } catch (e) { setError(errorMessage(e)); }
  };
  useEffect(() => { void load(); }, [installationId]);
  useEffect(() => {
    if (!deviceId) { setBots([]); return; }
    let active = true;
    api.listBots(deviceId).then(value => Promise.all(value.map(async bot => ({ ...bot, enabled: (await api.getBotCapability(deviceId, bot.botId, installationId)).enabled })))).then(value => { if (active) setBots(value); }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [deviceId, installationId]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await work(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  const request = async (kind: 'update' | 'rollback' | 'disable' | 'enable' | 'uninstall') => {
    if ((kind === 'uninstall' || kind === 'disable') && !window.confirm(kind === 'uninstall' ? '卸载此实例？默认保留数据。' : '禁用此实例？')) return;
    await run(async () => {
      const body = { requestId: crypto.randomUUID() };
      let source: { type: 'artifact'; artifactRef: string } | undefined;
      if (kind === 'update' && item?.source.type === 'artifact') {
        if (!artifact) throw new Error('请选择新版 tgz 制品');
        const uploaded = await api.uploadArtifact(artifact);
        source = { type: 'artifact', artifactRef: uploaded.artifactRef };
      }
      const accepted = kind === 'update' ? await api.updateInstallation(installationId, { ...body, targetVersion: version, ...(source && { source }) }) : kind === 'rollback' ? await api.rollbackInstallation(installationId, body) : kind === 'disable' ? await api.disableInstallation(installationId, body) : kind === 'enable' ? await api.enableInstallation(installationId, body) : await api.uninstallInstallation(installationId, body);
      setOperation(accepted.operationId);
    });
  };
  const selectedAction = actions.find(entry => entry.id === action);
  const chooseDevice = (id: string) => { setDeviceId(id); setBotId(''); setBots([]); setTools(undefined); setFlow(undefined); setFlowStatus(''); };
  const chooseBot = (id: string) => { setBotId(id); setTools(undefined); setFlow(undefined); setFlowStatus(''); };
  return <main className="config-page"><Link to="/capabilities">返回能力列表</Link><h1>{item?.displayName ?? '能力详情'}</h1>{error && <p role="alert" className="config-error">{error}</p>}{message && <p role="status">{message}</p>}
    <nav className="config-tabs" aria-label="详情页面">{['概览', '配置', '分配', '版本与状态', '操作'].map(name => <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {item && tab === '概览' && <section><h2>概览</h2><p>类型：{item.kind} · 包：{item.packageId}</p><p>目标：{item.target} · 目标版本：{item.targetVersion} · {item.enabled ? '启用' : '禁用'}</p><p>来源：{item.source.type === 'npm' ? item.source.spec : item.source.type === 'http' ? item.source.url : item.source.artifactRef}</p><label>检查使用的设备 <select disabled={busy} value={deviceId} onChange={event => chooseDevice(event.target.value)}><option value="">选择设备</option>{devices.map(device => <option value={device.deviceId} key={device.deviceId}>{device.name} · {device.online ? '在线' : '离线'}</option>)}</select></label><label>Bot <select disabled={busy} value={botId} onChange={event => chooseBot(event.target.value)}><option value="">选择 Bot</option>{bots.map(bot => <option value={bot.botId} key={bot.botId}>{bot.name} · {bot.enabled ? '已启用' : '未启用'}</option>)}</select></label><button disabled={busy || !deviceId || !botId} onClick={() => void run(async () => { const checked = await api.validateInstallation(installationId, { deviceId, botId }); setMessage(`${checked.ok ? '检查通过' : '检查失败'}：${checked.message}`); })}>检查连接</button>
      {item.kind === 'mcp' && <><h3>MCP 工具</h3><button disabled={busy || !deviceId || !botId} onClick={() => void run(async () => { setTools((await api.listInstallationTools(installationId, { deviceId, botId })).tools); })}>读取工具列表</button>{tools && (tools.length ? <ul>{tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong>{tool.description && ` · ${tool.description}`}<pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></li>)}</ul> : <p>无可用工具。</p>)}
      {item.target === 'center' && <><h3>HTTP OAuth</h3><p>仅中心托管的 HTTP MCP 且有效配置启用 OAuth 时可用。</p><button disabled={busy || !deviceId || !botId} onClick={() => void run(async () => { setFlow(await api.startMcpOAuth(installationId, { deviceId, botId })); setFlowStatus('pending'); })}>开始授权</button>{flow && <><p><a href={flow.authorizationUrl} target="_blank" rel="noreferrer">打开授权页面</a> · 状态：{flowStatus}</p><button disabled={busy} onClick={() => void run(async () => { const status = await api.getMcpOAuthFlow(flow.flowId); setFlowStatus(status.error ? `${status.status}：${status.error}` : status.status); })}>查询授权状态</button></>}<button disabled={busy || !deviceId || !botId} onClick={() => void run(async () => { await api.logoutMcpOAuth(installationId, { deviceId, botId }); setFlow(undefined); setFlowStatus(''); setMessage('OAuth 已退出'); })}>退出授权</button></>}</>}</section>}
    {config && tab === '配置' && <section><h2>全局配置</h2><ConfigForm key={config.revision} schema={config.configSchema} uiSchema={config.uiSchema} globalConfig={config.globalConfig} onSave={value => void run(async () => { setConfig(await api.putInstallationConfig(installationId, { expectedRevision: config.revision, globalConfig: value })); setMessage('全局配置已保存'); })}/></section>}
    {tab === '分配' && <section><h2>Bot 分配</h2><label>设备 <select disabled={busy} value={deviceId} onChange={event => chooseDevice(event.target.value)}><option value="">选择设备</option>{devices.map(device => <option value={device.deviceId} key={device.deviceId}>{device.name} · {device.online ? '在线' : '离线'}</option>)}</select></label><ul className="config-list">{bots.map(bot => <li key={bot.botId}><Link to={`/devices/${encodeURIComponent(bot.deviceId)}/bots/${encodeURIComponent(bot.botId)}/capabilities`}>{bot.name}</Link> · {bot.botId} · {bot.enabled ? '已分配' : '未启用'}</li>)}</ul><p>打开 Bot 配置可启用、禁用并设置覆盖。</p></section>}
    {tab === '版本与状态' && <section><h2>版本与部署状态</h2><p>目标版本：{item?.targetVersion}</p>{item?.source.type === 'npm' && <button disabled={busy} onClick={() => void run(async () => { setVersions(await api.checkUpdates(installationId)); setMessage('版本查询完成'); })}>检查更新</button>}<ul>{versions.map(v => <li key={v.version}><button onClick={() => setVersion(v.version)}>{v.version}</button> · {v.resolved ?? '制品'}</li>)}</ul><label>目标版本 <input value={version} onChange={event => setVersion(event.target.value)}/></label>{item?.source.type === 'artifact' && <label>新版 tgz 制品 <input type="file" accept=".tgz,.tar.gz,application/gzip" onChange={event => setArtifact(event.target.files?.[0])}/></label>}{item?.source.type !== 'http' && <button disabled={busy || !version || (item?.source.type === 'artifact' && !artifact)} onClick={() => void request('update')}>提交更新</button>}<button disabled={busy} onClick={() => void request('rollback')}>回滚</button><h3>部署回执</h3><button disabled={busy} onClick={() => void load()}>刷新状态</button>{receipts.length === 0 && <p>暂无回执。</p>}<ul>{receipts.map((receipt, index) => <li key={`${receipt.operationId}:${receipt.deviceId ?? 'center'}:${index}`}>{receipt.deviceId ?? '中心'} · {receipt.phase} · {receipt.health} · 实际版本 {receipt.actualVersion ?? '未应用'} · 目标版本 {item?.targetVersion} · 期望修订 {receipt.desiredRevision} / 已应用修订 {receipt.appliedRevision ?? '无'}{receipt.actualVersion !== item?.targetVersion || receipt.appliedRevision !== receipt.desiredRevision ? ' · 与目标不一致' : ''}{receipt.error && ` · ${receipt.error.message}`}</li>)}</ul></section>}
    {tab === '操作' && <section><h2>实例操作</h2>{item?.enabled ? <button disabled={busy} onClick={() => void request('disable')}>禁用</button> : <button disabled={busy || !item} onClick={() => void request('enable')}>恢复全局启用</button>}<button disabled={busy} onClick={() => void request('uninstall')}>卸载（保留数据）</button><h3>插件动作</h3>{actions.length === 0 ? <p>此实例未声明动作。</p> : <>
      <label>动作 <select value={action} onChange={event => { setAction(event.target.value); setResult(undefined); }}><option value="">选择动作</option>{actions.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
      <label>设备 <select disabled={busy} value={deviceId} onChange={event => chooseDevice(event.target.value)}><option value="">选择设备</option>{devices.map(device => <option value={device.deviceId} key={device.deviceId}>{device.name} · {device.online ? '在线' : '离线'}</option>)}</select></label>
      <label>Bot <select disabled={busy} value={botId} onChange={event => chooseBot(event.target.value)}><option value="">选择 Bot</option>{bots.filter(bot => bot.enabled).map(bot => <option value={bot.botId} key={bot.botId}>{bot.name}</option>)}</select></label>
      {selectedAction && <Form key={selectedAction.id} schema={selectedAction.inputSchema as RJSFSchema} validator={validator} onSubmit={({ formData }) => void run(async () => { const response = await api.runAction(installationId, selectedAction.id, { requestId: crypto.randomUUID(), deviceId, botId, input: formData as JsonValue }); setResult(response.result); })}><button disabled={busy || !deviceId || !botId}>执行动作</button></Form>}{result !== undefined && <pre>{JSON.stringify(result, null, 2)}</pre>}</>}</section>}
    {operation && <ConfigOperation key={operation} id={operation} onFinished={() => void load()}/>}
  </main>;
}
