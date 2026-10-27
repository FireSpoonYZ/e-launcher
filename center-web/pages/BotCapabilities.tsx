import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { BotCapabilityConfig, Installation, InstallationConfig, JsonObject } from '@e-launcher/center-contract';
import { api } from '../api';
import ConfigForm from '../components/ConfigForm';
import { errorMessage } from '../components/ConfigOperation';
import '../components/Config.css';

type Entry = { installation: Installation; config: BotCapabilityConfig; ui: InstallationConfig['uiSchema'] };
export default function BotCapabilities() {
  const { deviceId = '', botId = '' } = useParams();
  const [entries, setEntries] = useState<Entry[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(''), [loaded, setLoaded] = useState(false);
  const load = async () => {
    try {
      const installations = await api.listCapabilities();
      const next = await Promise.all(installations.map(async installation => {
        const [config, global] = await Promise.all([api.getBotCapability(deviceId, botId, installation.installationId), api.getInstallationConfig(installation.installationId)]);
        return { installation, config, ui: global.uiSchema };
      }));
      setEntries(next); setError('');
    } catch (e) { setError(errorMessage(e)); } finally { setLoaded(true); }
  };
  useEffect(() => { void load(); }, [deviceId, botId]);
  const save = async (entry: Entry, enabled: boolean, overrides: JsonObject) => {
    setBusy(entry.installation.installationId); setError('');
    try {
      const config = await api.putBotCapability(deviceId, botId, entry.installation.installationId, { expectedRevision: entry.config.revision, enabled, overrides });
      setEntries(current => current.map(item => item.installation.installationId === entry.installation.installationId ? { ...item, config } : item));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  };
  return <main className="config-page"><h1>Bot 能力配置</h1><p>设备 {deviceId} · Bot {botId}</p><Link to="/capabilities">返回能力列表</Link>{error && <p role="alert" className="config-error">{error}</p>}{!loaded && <p>加载中…</p>}{loaded && entries.length === 0 && <p>暂无安装实例。</p>}
    {entries.map(entry => <section key={entry.installation.installationId}><h2><Link to={`/capabilities/${encodeURIComponent(entry.installation.installationId)}`}>{entry.installation.displayName}</Link></h2><p>{entry.installation.kind} · 全局{entry.installation.enabled ? '启用' : '禁用'} · 版本 {entry.installation.targetVersion}</p>
      <label><input type="checkbox" checked={entry.config.enabled} disabled={!!busy} onChange={event => void save(entry, event.target.checked, entry.config.overrides)}/> 为此 Bot 启用</label>
      <ConfigForm key={`${entry.installation.installationId}:${entry.config.revision}`} schema={entry.config.configSchema} uiSchema={entry.ui} globalConfig={entry.config.globalConfig} overrides={entry.config.overrides} onSave={value => void save(entry, entry.config.enabled, value)}/>
    </section>)}
  </main>;
}
