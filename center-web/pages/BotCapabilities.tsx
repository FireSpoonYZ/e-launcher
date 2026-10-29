import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Sliders } from 'lucide-react';
import type { BotCapabilityConfig, Installation, InstallationConfig, JsonObject } from '@e-launcher/center-contract';
import { api } from '../api';
import ConfigForm from '../components/ConfigForm';
import { errorMessage } from '../components/ConfigOperation';
import { SheetModal } from '../components/SheetModal';
import '../components/Config.css';

type Entry = {
  installation: Installation;
  config: BotCapabilityConfig;
  ui: InstallationConfig['uiSchema'];
};

export default function BotCapabilities() {
  const { deviceId = '', botId = '' } = useParams();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [editingId, setEditingId] = useState('');

  const load = async () => {
    try {
      const installations = await api.listCapabilities();
      const next = await Promise.all(
        installations.map(async installation => {
          const [config, global] = await Promise.all([
            api.getBotCapability(deviceId, botId, installation.installationId),
            api.getInstallationConfig(installation.installationId),
          ]);
          return { installation, config, ui: global.uiSchema };
        }),
      );
      setEntries(next);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, [deviceId, botId]);

  const save = async (entry: Entry, enabled: boolean, overrides: JsonObject) => {
    setBusy(entry.installation.installationId);
    setError('');
    try {
      const config = await api.putBotCapability(deviceId, botId, entry.installation.installationId, {
        expectedRevision: entry.config.revision,
        enabled,
        overrides,
      });
      setEntries(current =>
        current.map(item =>
          item.installation.installationId === entry.installation.installationId
            ? { ...item, config }
            : item,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  };

  const enabledCount = entries.filter(entry => entry.config.enabled).length;
  const disabledCount = entries.length - enabledCount;
  const visibleEntries = entries.filter(entry => {
    if (filterStatus === 'enabled') return entry.config.enabled;
    if (filterStatus === 'disabled') return !entry.config.enabled;
    return true;
  });
  const editingEntry = entries.find(entry => entry.installation.installationId === editingId);

  return (
    <main className="page config-page">
      <div className="action-row">
        <Link to="/devices" className="quiet-button">
          ← 返回设备与 Bot
        </Link>
        <Link to="/capabilities" className="quiet-button">
          返回能力列表
        </Link>
      </div>

      <header className="page-header">
        <div className="page-title-group">
          <h1>Bot 能力配置</h1>
          <p className="secondary">
            设备 {deviceId} · Bot {botId}
          </p>
        </div>
      </header>

      {error && (
        <p role="alert" className="inline-error config-error">
          {error}
        </p>
      )}

      {loaded && entries.length > 0 && (
        <div className="filter-bar" role="group" aria-label="启用状态筛选">
          <button
            type="button"
            className={`filter-chip ${filterStatus === 'all' ? 'is-active' : ''}`}
            aria-pressed={filterStatus === 'all'}
            onClick={() => setFilterStatus('all')}
          >
            全部 ({entries.length})
          </button>
          <button
            type="button"
            className={`filter-chip ${filterStatus === 'enabled' ? 'is-active' : ''}`}
            aria-pressed={filterStatus === 'enabled'}
            onClick={() => setFilterStatus('enabled')}
          >
            已为该 Bot 启用 ({enabledCount})
          </button>
          <button
            type="button"
            className={`filter-chip ${filterStatus === 'disabled' ? 'is-active' : ''}`}
            aria-pressed={filterStatus === 'disabled'}
            onClick={() => setFilterStatus('disabled')}
          >
            未启用 ({disabledCount})
          </button>
        </div>
      )}

      {!loaded && <p className="empty-state secondary">加载中…</p>}
      {loaded && entries.length === 0 && <p className="empty-state secondary">暂无安装实例。</p>}
      {loaded && entries.length > 0 && visibleEntries.length === 0 && (
        <p className="empty-state secondary">当前筛选条件下暂无能力实例。</p>
      )}

      {visibleEntries.length > 0 && (
        <div className="card-grid">
          {visibleEntries.map(entry => {
            const overrideCount = Object.keys(entry.config.overrides).length;
            return (
              <section key={entry.installation.installationId} className="card-group resource-row">
                <div className="card-header">
                  <h2>
                    <Link to={`/capabilities/${encodeURIComponent(entry.installation.installationId)}`}>
                      {entry.installation.displayName}
                    </Link>
                  </h2>
                  <div className="action-row">
                    <span
                      className={`badge ${
                        entry.installation.kind === 'plugin'
                          ? 'badge-primary'
                          : entry.installation.kind === 'mcp'
                            ? 'badge-accent'
                            : 'badge-neutral'
                      }`}
                    >
                      {entry.installation.kind}
                    </span>
                    <span
                      className={`badge ${entry.installation.enabled ? 'badge-online' : 'badge-offline'}`}
                    >
                      全局{entry.installation.enabled ? '启用' : '禁用'}
                    </span>
                    <span className="badge badge-neutral">版本 {entry.installation.targetVersion}</span>
                    <span className={`badge ${overrideCount > 0 ? 'badge-accent' : 'badge-neutral'}`}>
                      {overrideCount > 0 ? '已自定义覆盖' : '继承全局配置'}
                    </span>
                  </div>
                </div>

                <div className="action-row">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={entry.config.enabled}
                      disabled={!!busy}
                      onChange={event =>
                        void save(entry, event.target.checked, entry.config.overrides)
                      }
                    />
                    为此 Bot 启用
                  </label>
                  <button
                    type="button"
                    className="button secondary-button button-sm"
                    onClick={() => setEditingId(entry.installation.installationId)}
                  >
                    <Sliders size={15} aria-hidden="true" />
                    配置覆盖参数
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <SheetModal
        open={editingEntry !== undefined}
        onOpenChange={open => {
          if (!open) setEditingId('');
        }}
        title={`${editingEntry?.installation.displayName ?? ''} — Bot 覆盖配置`}
        description={`设备 ${deviceId} · Bot ${botId}`}
        size="lg"
      >
        {editingEntry && (
          <ConfigForm
            key={`${editingEntry.installation.installationId}:${editingEntry.config.revision}`}
            schema={editingEntry.config.configSchema}
            uiSchema={editingEntry.ui}
            globalConfig={editingEntry.config.globalConfig}
            overrides={editingEntry.config.overrides}
            onSave={async value => {
              await save(editingEntry, editingEntry.config.enabled, value);
              setEditingId('');
            }}
          />
        )}
      </SheetModal>
    </main>
  );
}
