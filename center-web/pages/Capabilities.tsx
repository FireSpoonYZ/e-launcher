import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilityKind, Installation, InstallSource } from '@e-launcher/center-contract';
import { api } from '../api';
import { ConfigOperation, errorMessage } from '../components/ConfigOperation';
import '../components/Config.css';

export default function Capabilities() {
  const [items, setItems] = useState<Installation[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<CapabilityKind>('plugin'), [name, setName] = useState(''), [sourceType, setSourceType] = useState<InstallSource['type']>('npm'), [source, setSource] = useState(''), [file, setFile] = useState<File>(), [target, setTarget] = useState<'center' | 'host'>('host'), [operation, setOperation] = useState('');
  const load = async () => { try { setItems(await api.listCapabilities()); } catch (e) { setError(errorMessage(e)); } };
  useEffect(() => { void load(); }, []);
  const install = async () => {
    setBusy(true); setError('');
    try {
      let input: InstallSource;
      if (sourceType === 'artifact') { if (!file) throw new Error('请选择制品文件'); const uploaded = await api.uploadArtifact(file); input = { type: 'artifact', artifactRef: uploaded.artifactRef }; }
      else input = sourceType === 'http' ? { type: 'http', url: source } : { type: 'npm', spec: source };
      const accepted = await api.install({ requestId: crypto.randomUUID(), displayName: name, kind, source: input, target });
      setOperation(accepted.operationId);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <main className="config-page"><h1>插件、MCP 与 Skill</h1><p>安装实例由中心管理，每个 Bot 单独启用。</p>{error && <p className="config-error" role="alert">{error}</p>}
    <section><h2>安装或登记</h2><form onSubmit={event => { event.preventDefault(); void install(); }}>
      <label>类型 <select value={kind} onChange={event => setKind(event.target.value as CapabilityKind)}><option value="plugin">插件</option><option value="mcp">MCP</option><option value="skill">Skill</option></select></label>
      <label>名称 <input required value={name} onChange={event => setName(event.target.value)}/></label>
      <label>来源 <select value={sourceType} onChange={event => setSourceType(event.target.value as InstallSource['type'])}><option value="npm">npm</option><option value="artifact">本地制品</option><option value="http">HTTP MCP</option></select></label>
      {sourceType === 'artifact' ? <label>制品 <input type="file" required onChange={event => setFile(event.target.files?.[0])}/></label> : <label>{sourceType === 'http' ? 'HTTP URL' : 'npm 包及版本'} <input required value={source} onChange={event => setSource(event.target.value)}/></label>}
      <label>执行目标 <select value={target} onChange={event => setTarget(event.target.value as 'center' | 'host')}><option value="host">Host</option><option value="center">中心</option></select></label>
      {sourceType === 'http' && <p>HTTP MCP 只登记远程端点，不下载安装远程服务。</p>}<button disabled={busy}>提交安装</button></form>
      {operation && <ConfigOperation key={operation} id={operation} onFinished={() => void load()}/>}</section>
    {(['plugin', 'mcp', 'skill'] as const).map(type => <section key={type}><h2>{type === 'plugin' ? '插件' : type === 'mcp' ? 'MCP' : 'Skill'}</h2><ul className="config-list">{items.filter(item => item.kind === type).map(item => <li key={item.installationId}><Link to={`/capabilities/${encodeURIComponent(item.installationId)}`}>{item.displayName}</Link> · {item.targetVersion} · {item.enabled ? '启用' : '禁用'} · {item.target}</li>)}</ul></section>)}
  </main>;
}
