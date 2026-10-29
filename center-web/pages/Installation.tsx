import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Form from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import type { RJSFSchema } from '@rjsf/utils';
import { ArrowLeft, ExternalLink, Play, Power, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type {
  BotRef,
  CapabilityTool,
  DeploymentReceipt,
  Device,
  Installation as InstallationDto,
  InstallationConfig,
  JsonSchema,
  JsonValue,
  PackageVersion,
} from '@e-launcher/center-contract';
import { api } from '../api';
import ConfigForm from '../components/ConfigForm';
import { ConfigOperation, errorMessage } from '../components/ConfigOperation';
import '../components/Config.css';

type ActionDescriptor = {
  id: string;
  title: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
};

const TABS = ['概览', '配置', '分配', '版本与状态', '操作'] as const;
const validator = customizeValidator({ customFormats: { 'credential-ref': /.*/ } });

export default function Installation() {
  const { installationId = '' } = useParams();
  const [item, setItem] = useState<InstallationDto>();
  const [config, setConfig] = useState<InstallationConfig>();
  const [receipts, setReceipts] = useState<DeploymentReceipt[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [bots, setBots] = useState<(BotRef & { enabled: boolean })[]>([]);
  const [actions, setActions] = useState<ActionDescriptor[]>([]);
  const [versions, setVersions] = useState<PackageVersion[]>([]);
  const [artifact, setArtifact] = useState<File>();
  const [tools, setTools] = useState<CapabilityTool[]>();
  const [flow, setFlow] = useState<{ flowId: string; authorizationUrl: string }>();
  const [flowStatus, setFlowStatus] = useState('');
  const [tab, setTab] = useState<string>('概览');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState('');
  const [version, setVersion] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [botId, setBotId] = useState('');
  const [action, setAction] = useState('');
  const [result, setResult] = useState<JsonValue>();

  const load = async () => {
    try {
      const [installation, nextConfig, deployments, nextDevices, descriptors] = await Promise.all([
        api.getInstallation(installationId),
        api.getInstallationConfig(installationId),
        api.listDeployments(installationId),
        api.listDevices(),
        api.listActions(installationId),
      ]);
      setItem(installation);
      setConfig(nextConfig);
      setReceipts(deployments);
      setDevices(nextDevices);
      setActions(descriptors);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
  }, [installationId]);

  useEffect(() => {
    if (!deviceId) {
      setBots([]);
      return;
    }
    let active = true;
    api
      .listBots(deviceId)
      .then(value =>
        Promise.all(
          value.map(async bot => ({
            ...bot,
            enabled: (await api.getBotCapability(deviceId, bot.botId, installationId)).enabled,
          })),
        ),
      )
      .then(value => {
        if (active) setBots(value);
      })
      .catch(e => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [deviceId, installationId]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const request = async (kind: 'update' | 'rollback' | 'disable' | 'enable' | 'uninstall') => {
    if (
      (kind === 'uninstall' || kind === 'disable') &&
      !window.confirm(kind === 'uninstall' ? '卸载此实例？默认保留数据。' : '禁用此实例？')
    ) {
      return;
    }
    await run(async () => {
      const body = { requestId: crypto.randomUUID() };
      let source: { type: 'artifact'; artifactRef: string } | undefined;
      if (kind === 'update' && item?.source.type === 'artifact') {
        if (!artifact) throw new Error('请选择新版 tgz 制品');
        const uploaded = await api.uploadArtifact(artifact);
        source = { type: 'artifact', artifactRef: uploaded.artifactRef };
      }
      const accepted =
        kind === 'update'
          ? await api.updateInstallation(installationId, {
              ...body,
              targetVersion: version,
              ...(source && { source }),
            })
          : kind === 'rollback'
            ? await api.rollbackInstallation(installationId, body)
            : kind === 'disable'
              ? await api.disableInstallation(installationId, body)
              : kind === 'enable'
                ? await api.enableInstallation(installationId, body)
                : await api.uninstallInstallation(installationId, body);
      setOperation(accepted.operationId);
    });
  };

  const toggleBotCapability = async (bot: BotRef & { enabled: boolean }, nextEnabled: boolean) => {
    await run(async () => {
      const current = await api.getBotCapability(deviceId, bot.botId, installationId);
      const updated = await api.putBotCapability(deviceId, bot.botId, installationId, {
        expectedRevision: current.revision,
        enabled: nextEnabled,
        overrides: current.overrides,
      });
      setBots(prev =>
        prev.map(entry => (entry.botId === bot.botId ? { ...entry, enabled: updated.enabled } : entry)),
      );
      setMessage(`${bot.name} 已${updated.enabled ? '启用' : '停用'}此能力`);
    });
  };

  const selectedAction = actions.find(entry => entry.id === action);
  const chooseDevice = (id: string) => {
    setDeviceId(id);
    setBotId('');
    setBots([]);
    setTools(undefined);
    setFlow(undefined);
    setFlowStatus('');
  };
  const chooseBot = (id: string) => {
    setBotId(id);
    setTools(undefined);
    setFlow(undefined);
    setFlowStatus('');
  };

  return (
    <main className="page config-page">
      <div className="action-row">
        <Link to="/capabilities" className="quiet-button">
          <ArrowLeft size={16} aria-hidden="true" />
          返回能力列表
        </Link>
      </div>

      <section className="card-group">
        <div className="card-header">
          <div className="page-title-group">
            <h1>{item?.displayName ?? '能力详情'}</h1>
          </div>
          {item && (
            <div className="action-row">
              <span
                className={`badge ${
                  item.kind === 'plugin'
                    ? 'badge-primary'
                    : item.kind === 'mcp'
                      ? 'badge-accent'
                      : 'badge-neutral'
                }`}
              >
                {item.kind}
              </span>
              <span className={`badge ${item.enabled ? 'badge-online' : 'badge-offline'}`}>
                {item.enabled ? '已启用' : '已禁用'}
              </span>
              <span className="badge badge-neutral">目标：{item.target}</span>
              <span className="badge badge-neutral">版本：{item.targetVersion}</span>
              <span className="badge badge-neutral">包：{item.packageId}</span>
            </div>
          )}
        </div>
      </section>

      {error && (
        <p role="alert" className="inline-error config-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="inline-notice">
          {message}
        </p>
      )}
      {operation && <ConfigOperation key={operation} id={operation} onFinished={() => void load()} />}

      <nav className="config-tabs" aria-label="详情页面">
        {TABS.map(name => (
          <button key={name} type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </nav>

      {item && tab === '概览' && (
        <>
          <section className="card-group">
            <div className="card-header">
              <h2>概览</h2>
            </div>
            <div className="summary-bar">
              <p>
                类型：{item.kind} · 包：{item.packageId}
              </p>
              <p>
                目标：{item.target} · 目标版本：{item.targetVersion} · {item.enabled ? '启用' : '禁用'}
              </p>
              <p>
                来源：
                {item.source.type === 'npm'
                  ? item.source.spec
                  : item.source.type === 'http'
                    ? item.source.url
                    : item.source.artifactRef}
              </p>
            </div>
            <div className="form form-grid">
              <label>
                检查使用的设备
                <select
                  disabled={busy}
                  value={deviceId}
                  onChange={event => chooseDevice(event.target.value)}
                >
                  <option value="">选择设备</option>
                  {devices.map(device => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.name} · {device.online ? '在线' : '离线'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Bot
                <select disabled={busy} value={botId} onChange={event => chooseBot(event.target.value)}>
                  <option value="">选择 Bot</option>
                  {bots.map(bot => (
                    <option value={bot.botId} key={bot.botId}>
                      {bot.name} · {bot.enabled ? '已启用' : '未启用'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="action-row">
              <button
                type="button"
                className="button secondary-button button-sm"
                disabled={busy || !deviceId || !botId}
                onClick={() =>
                  void run(async () => {
                    const checked = await api.validateInstallation(installationId, { deviceId, botId });
                    setMessage(`${checked.ok ? '检查通过' : '检查失败'}：${checked.message}`);
                  })
                }
              >
                <RefreshCw size={15} aria-hidden="true" />
                检查连接
              </button>
            </div>
          </section>

          {item.kind === 'mcp' && (
            <section className="card-group">
              <div className="card-header">
                <h3>MCP 工具</h3>
                <button
                  type="button"
                  className="button secondary-button button-sm"
                  disabled={busy || !deviceId || !botId}
                  onClick={() =>
                    void run(async () => {
                      setTools((await api.listInstallationTools(installationId, { deviceId, botId })).tools);
                    })
                  }
                >
                  读取工具列表
                </button>
              </div>
              {(!deviceId || !botId) && (
                <p className="secondary">请先在上方选择设备与 Bot 后读取工具列表。</p>
              )}
              {tools &&
                (tools.length ? (
                  <div className="card-grid">
                    {tools.map(tool => (
                      <article key={tool.name} className="resource-card resource-row">
                        <div className="card-header">
                          <strong>{tool.name}</strong>
                          {tool.description && <span className="secondary">{tool.description}</span>}
                        </div>
                        <details className="fold-panel">
                          <summary>查看输入 Schema</summary>
                          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state secondary">无可用工具。</p>
                ))}
            </section>
          )}

          {item.kind === 'mcp' && item.target === 'center' && (
            <section className="card-group">
              <div className="card-header">
                <h3>HTTP OAuth</h3>
              </div>
              <p className="secondary">仅中心托管的 HTTP MCP 且有效配置启用 OAuth 时可用。</p>
              <div className="action-row">
                <button
                  type="button"
                  className="button secondary-button button-sm"
                  disabled={busy || !deviceId || !botId}
                  onClick={() =>
                    void run(async () => {
                      setFlow(await api.startMcpOAuth(installationId, { deviceId, botId }));
                      setFlowStatus('pending');
                    })
                  }
                >
                  开始授权
                </button>
                {flow && (
                  <button
                    type="button"
                    className="button secondary-button button-sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const status = await api.getMcpOAuthFlow(flow.flowId);
                        setFlowStatus(status.error ? `${status.status}：${status.error}` : status.status);
                      })
                    }
                  >
                    查询授权状态
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary-button button-sm"
                  disabled={busy || !deviceId || !botId}
                  onClick={() =>
                    void run(async () => {
                      await api.logoutMcpOAuth(installationId, { deviceId, botId });
                      setFlow(undefined);
                      setFlowStatus('');
                      setMessage('OAuth 已退出');
                    })
                  }
                >
                  退出授权
                </button>
              </div>
              {flow && (
                <p className="inline-notice">
                  <a href={flow.authorizationUrl} target="_blank" rel="noreferrer">
                    打开授权页面 <ExternalLink size={14} aria-hidden="true" />
                  </a>{' '}
                  · 状态：<span className="badge badge-neutral">{flowStatus}</span>
                </p>
              )}
            </section>
          )}
        </>
      )}

      {config && tab === '配置' && (
        <section className="card-group">
          <div className="card-header">
            <h2>全局配置</h2>
          </div>
          <ConfigForm
            key={config.revision}
            schema={config.configSchema}
            uiSchema={config.uiSchema}
            globalConfig={config.globalConfig}
            onSave={value =>
              void run(async () => {
                setConfig(
                  await api.putInstallationConfig(installationId, {
                    expectedRevision: config.revision,
                    globalConfig: value,
                  }),
                );
                setMessage('全局配置已保存');
              })
            }
          />
        </section>
      )}

      {tab === '分配' && (
        <section className="card-group">
          <div className="card-header">
            <h2>Bot 分配</h2>
          </div>
          <p className="secondary">打开 Bot 配置可启用、禁用并设置覆盖，也可直接在此处快速切换启用状态。</p>
          <div className="form">
            <label>
              设备
              <select
                disabled={busy}
                value={deviceId}
                onChange={event => chooseDevice(event.target.value)}
              >
                <option value="">选择设备</option>
                {devices.map(device => (
                  <option value={device.deviceId} key={device.deviceId}>
                    {device.name} · {device.online ? '在线' : '离线'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!deviceId ? (
            <p className="empty-state secondary">请先选择设备以管理其下的 Bot 分配状态。</p>
          ) : bots.length === 0 ? (
            <p className="empty-state secondary">该设备下暂无 Bot。</p>
          ) : (
            <div className="card-grid">
              {bots.map(bot => (
                <article key={bot.botId} className="resource-card resource-row">
                  <div className="card-header">
                    <div>
                      <Link
                        to={`/devices/${encodeURIComponent(bot.deviceId)}/bots/${encodeURIComponent(bot.botId)}/capabilities`}
                      >
                        <strong>{bot.name}</strong>
                      </Link>{' '}
                      <span className="secondary">· {bot.botId}</span>
                    </div>
                    <span className={`badge ${bot.enabled ? 'badge-online' : 'badge-offline'}`}>
                      {bot.enabled ? '已分配' : '未启用'}
                    </span>
                  </div>
                  <div className="action-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={bot.enabled}
                        disabled={busy}
                        onChange={event => void toggleBotCapability(bot, event.target.checked)}
                      />
                      为此 Bot 启用
                    </label>
                    <Link
                      className="quiet-button"
                      to={`/devices/${encodeURIComponent(bot.deviceId)}/bots/${encodeURIComponent(bot.botId)}/capabilities`}
                    >
                      配置覆盖参数 →
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === '版本与状态' && (
        <>
          <section className="card-group">
            <div className="card-header">
              <h2>版本更新与回滚</h2>
              {item?.source.type === 'npm' && (
                <button
                  type="button"
                  className="button secondary-button button-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setVersions(await api.checkUpdates(installationId));
                      setMessage('版本查询完成');
                    })
                  }
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  检查更新
                </button>
              )}
            </div>
            <p className="secondary">目标版本：{item?.targetVersion}</p>
            {versions.length > 0 && (
              <div className="filter-bar" role="group" aria-label="可用版本">
                {versions.map(v => (
                  <button
                    key={v.version}
                    type="button"
                    className={`filter-chip ${version === v.version ? 'is-active' : ''}`}
                    onClick={() => setVersion(v.version)}
                  >
                    {v.version} · {v.resolved ?? '制品'}
                  </button>
                ))}
              </div>
            )}
            <div className="form">
              <label>
                目标版本
                <input
                  value={version}
                  onChange={event => setVersion(event.target.value)}
                  placeholder="输入目标版本号或点击上方检测到的版本"
                />
              </label>
              {item?.source.type === 'artifact' && (
                <label>
                  新版 tgz 制品
                  <input
                    type="file"
                    accept=".tgz,.tar.gz,application/gzip"
                    onChange={event => setArtifact(event.target.files?.[0])}
                  />
                </label>
              )}
              <div className="action-row">
                {item?.source.type !== 'http' && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !version || (item?.source.type === 'artifact' && !artifact)}
                    onClick={() => void request('update')}
                  >
                    提交更新
                  </button>
                )}
                <button
                  type="button"
                  className="button secondary-button"
                  disabled={busy}
                  onClick={() => void request('rollback')}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  回滚
                </button>
              </div>
            </div>
          </section>

          <section className="card-group">
            <div className="card-header">
              <h3>部署回执</h3>
              <button
                type="button"
                className="button secondary-button button-sm"
                disabled={busy}
                onClick={() => void load()}
              >
                <RefreshCw size={15} aria-hidden="true" />
                刷新状态
              </button>
            </div>
            {receipts.length === 0 ? (
              <p className="empty-state secondary">暂无回执。</p>
            ) : (
              <div className="card-grid">
                {receipts.map((receipt, index) => {
                  const mismatch =
                    receipt.actualVersion !== item?.targetVersion ||
                    receipt.appliedRevision !== receipt.desiredRevision;
                  return (
                    <article
                      key={`${receipt.operationId}:${receipt.deviceId ?? 'center'}:${index}`}
                      className="resource-card resource-row"
                    >
                      <div className="card-header">
                        <strong>{receipt.deviceId ?? '中心'}</strong>
                        <div className="action-row">
                          <span
                            className={`badge ${
                              receipt.phase === 'applied'
                                ? 'badge-success'
                                : receipt.phase === 'failed'
                                  ? 'badge-danger'
                                  : 'badge-neutral'
                            }`}
                          >
                            {receipt.phase}
                          </span>
                          <span
                            className={`badge ${
                              receipt.health === 'ready'
                                ? 'badge-online'
                                : receipt.health === 'disabled'
                                  ? 'badge-offline'
                                  : 'badge-warn'
                            }`}
                          >
                            {receipt.health}
                          </span>
                          {mismatch && <span className="badge badge-warn">与目标不一致</span>}
                        </div>
                      </div>
                      <p className="secondary">
                        实际版本 {receipt.actualVersion ?? '未应用'} / 目标版本 {item?.targetVersion} · 期望修订{' '}
                        {receipt.desiredRevision} / 已应用修订 {receipt.appliedRevision ?? '无'}
                      </p>
                      {receipt.error && <p className="inline-error">{receipt.error.message}</p>}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {tab === '操作' && (
        <>
          <section className="card-group">
            <div className="card-header">
              <h2>插件动作</h2>
            </div>
            {actions.length === 0 ? (
              <p className="empty-state secondary">此实例未声明动作。</p>
            ) : (
              <div className="form">
                <div className="form-grid">
                  <label>
                    动作
                    <select
                      value={action}
                      onChange={event => {
                        setAction(event.target.value);
                        setResult(undefined);
                      }}
                    >
                      <option value="">选择动作</option>
                      {actions.map(entry => (
                        <option key={entry.id} value={entry.id}>
                          {entry.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    设备
                    <select
                      disabled={busy}
                      value={deviceId}
                      onChange={event => chooseDevice(event.target.value)}
                    >
                      <option value="">选择设备</option>
                      {devices.map(device => (
                        <option value={device.deviceId} key={device.deviceId}>
                          {device.name} · {device.online ? '在线' : '离线'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Bot
                    <select disabled={busy} value={botId} onChange={event => chooseBot(event.target.value)}>
                      <option value="">选择 Bot</option>
                      {bots
                        .filter(bot => bot.enabled)
                        .map(bot => (
                          <option value={bot.botId} key={bot.botId}>
                            {bot.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                {selectedAction && (
                  <div className="config-form">
                    <Form
                      key={selectedAction.id}
                      schema={selectedAction.inputSchema as RJSFSchema}
                      validator={validator}
                      onSubmit={({ formData }) =>
                        void run(async () => {
                          const response = await api.runAction(installationId, selectedAction.id, {
                            requestId: crypto.randomUUID(),
                            deviceId,
                            botId,
                            input: formData as JsonValue,
                          });
                          setResult(response.result);
                        })
                      }
                    >
                      <button type="submit" className="button" disabled={busy || !deviceId || !botId}>
                        <Play size={15} aria-hidden="true" />
                        执行动作
                      </button>
                    </Form>
                  </div>
                )}
                {result !== undefined && <pre>{JSON.stringify(result, null, 2)}</pre>}
              </div>
            )}
          </section>

          <section className="card-group">
            <div className="card-header">
              <h3>实例生命周期</h3>
            </div>
            <p className="secondary">可全局禁用或恢复此能力实例，或卸载实例（默认保留持久化数据）。</p>
            <div className="action-row">
              {item?.enabled ? (
                <button
                  type="button"
                  className="button secondary-button"
                  disabled={busy}
                  onClick={() => void request('disable')}
                >
                  <Power size={15} aria-hidden="true" />
                  禁用
                </button>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={busy || !item}
                  onClick={() => void request('enable')}
                >
                  <Power size={15} aria-hidden="true" />
                  恢复全局启用
                </button>
              )}
              <button
                type="button"
                className="button danger-button"
                disabled={busy}
                onClick={() => void request('uninstall')}
              >
                <Trash2 size={15} aria-hidden="true" />
                卸载（保留数据）
              </button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
