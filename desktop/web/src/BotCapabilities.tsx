// 手机与桌面共用的 Bot 能力面板（插件/MCP/技能）。
// 只经中心管理接口（owner 会话 + CAS 写入）读写，不经过目标 Host、不启用旧本地 getBotExtensions；
// 目标离线仍可在中心保存，但只有中心回执 applied 才显示“已生效”，不伪报。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CenterBotCapabilityEntry,
  CenterCapabilityActivationStatus,
  CenterDeviceRuntimeStatus,
  CenterRuntimeApplyStatus,
  JsonObject,
  JsonSchema,
  JsonValue,
} from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';

type Props = {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  t?: (zh: string, en: string) => string;
  /** 外层已有同名标题时可隐藏面板自带标题（手机 Bot 设置标签页）。 */
  showTitle?: boolean;
  /** 中心管理员登录成功后通知外层，同一弹窗内的其它视图可同步会话状态。 */
  onAuthenticated?: () => void;
};

/** 无法逐项渲染的 schema 用整段 JSON 覆写。 */
type FieldKind = 'string' | 'number' | 'boolean' | 'enum';

interface Field {
  key: string;
  kind: FieldKind;
  options?: string[];
}

interface Editor {
  installationId: string;
  /** 打开编辑器时的 CAS 基线；自动拉取不会替换它。 */
  revision: number;
  enabled: boolean;
  overrides: JsonObject;
  /** schema 不是扁平标量时的 JSON 覆写文本。 */
  text: string | null;
}

const REFRESH_MS = 2500;
const identityText = (zh: string): string => zh;
const formatRemoteError = (err: { code: string; message: string }): string =>
  err.message.startsWith(`${err.code}:`) ? err.message : `${err.code}: ${err.message}`;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 扁平标量属性可逐项“继承/覆盖”；嵌套、数组、未知类型返回 null（改用 JSON 覆写）。 */
function flatFields(schema: JsonSchema | undefined): Field[] | null {
  if (!isObject(schema)) return null;
  const properties = schema.properties;
  if (properties === undefined) return Object.keys(schema).length === 0 ? [] : null;
  if (!isObject(properties)) return null;
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!isObject(raw)) return null;
    const values = raw.enum;
    if (raw.type === 'string' && Array.isArray(values) && values.every((value) => typeof value === 'string')) {
      fields.push({ key, kind: 'enum', options: values as string[] });
    } else if (raw.type === 'boolean') {
      fields.push({ key, kind: 'boolean' });
    } else if (raw.type === 'string') {
      fields.push({ key, kind: 'string' });
    } else if (raw.type === 'number' || raw.type === 'integer') {
      fields.push({ key, kind: 'number' });
    } else {
      return null;
    }
  }
  return fields;
}

function timeText(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** 只有全局启用且已生效才可为本 Bot 开启；disabled/unknown/读取失败一律不算 ready。 */
function globallyReady(entry: CenterBotCapabilityEntry): boolean {
  return entry.installation.enabled === true && entry.installation.activation?.status === 'enabled';
}

export function BotCapabilities({ api, identity, deviceId, botId, t = identityText, showTitle = true, onAuthenticated }: Props) {
  const [entries, setEntries] = useState<CenterBotCapabilityEntry[]>([]);
  const [runtime, setRuntime] = useState<CenterDeviceRuntimeStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const seq = useRef(0);
  const busyRef = useRef('');
  const needLoginRef = useRef(false);
  // t 每次渲染都是新闭包：放进 ref，避免把 load 的 useCallback 依赖打穿成每帧重跑。
  const textRef = useRef(t);
  textRef.current = t;
  busyRef.current = busy;
  needLoginRef.current = needLogin;

  const load = useCallback(async (probeSession = true): Promise<void> => {
    const current = ++seq.current;
    try {
      const [list, status] = await Promise.all([
        api.broker(identity, 'center_bot_capabilities_get', { deviceId, botId }),
        api.broker(identity, 'center_runtime_status', { deviceId }).catch(() => null),
      ]);
      if (!alive.current || current !== seq.current) return;
      if (!Array.isArray(list)) throw new Error('invalid capability list');
      // 只替换基线与运行态；未保存的编辑器草稿不受影响。
      setEntries(list);
      setRuntime(status);
      setNeedLogin(false);
      setError('');
    } catch (failure) {
      if (!alive.current || current !== seq.current) return;
      const err = toError(failure);
      if (err.code === 'CONTROL_UNAUTHORIZED') {
        setNeedLogin(true);
        setError(probeSession ? '' : textRef.current('需要先在中心以管理员身份登录。', 'Center administrator login required.'));
        return;
      }
      setError(formatRemoteError(err));
    } finally {
      if (alive.current && current === seq.current) setLoaded(true);
    }
  }, [api, identity, deviceId, botId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      seq.current += 1;
    };
  }, [load]);

  // 显示时 2.5s 轮询（不重复探测会话）；页面隐藏/后台时暂停，回到前台补读一次。
  useEffect(() => {
    const tick = (): void => {
      if (document.hidden || busyRef.current !== '' || needLoginRef.current) return;
      void load(false);
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  async function login(): Promise<void> {
    const secret = password;
    setPassword('');
    setBusy('login');
    setError('');
    try {
      await api.broker(identity, 'center_owner_login', { password: secret });
      if (!alive.current) return;
      setNeedLogin(false);
      setBusy('');
      onAuthenticated?.();
      await load();
    } catch (failure) {
      if (!alive.current) return;
      const err = toError(failure);
      setError(formatRemoteError(err));
    } finally {
      if (alive.current) setBusy('');
    }
  }

  async function save(
    entry: CenterBotCapabilityEntry,
    enabled: boolean,
    overrides: JsonObject,
    expectedRevision: number,
  ): Promise<void> {
    if (enabled && !entry.config.enabled && !globallyReady(entry)) {
      setError(textRef.current('该能力全局未启用（或启用未完成），不能为本 Bot 开启；请先在中心启用并等待生效。', 'The capability is not enabled globally yet; enable it in the center first.'));
      return;
    }
    setBusy(entry.installation.installationId);
    setError('');
    setNotice('');
    try {
      const config = await api.broker(identity, 'center_bot_capability_set', {
        deviceId,
        botId,
        installationId: entry.installation.installationId,
        expectedRevision,
        enabled,
        overrides,
      });
      if (!alive.current) return;
      setEntries((previous) =>
        previous.map((item) => (item.installation.installationId === config.installationId ? { ...item, config } : item)),
      );
      setEditor(null);
      setNotice(runtime && !runtime.online
        ? textRef.current('已保存到中心；目标设备离线，待其上线后再同步应用。', 'Saved to the center; the target is offline and will sync when it reconnects.')
        : textRef.current('已保存到中心；目标应用完成后状态才会变为已生效。', 'Saved to the center; effective only after the target applies it.'));
      // 保存后立即重拉，尽快显示中心运行态与全局激活结果。
      void load(false);
    } catch (failure) {
      if (!alive.current) return;
      const err = toError(failure);
      if (err.code === 'CONTROL_UNAUTHORIZED') setNeedLogin(true);
      const message = err.code === 'REQUEST_CONFLICT'
        ? textRef.current('保存冲突（REQUEST_CONFLICT）：远端已变化，本次写入未生效。已重新读取；草稿保留，可用“采用远端（丢弃草稿）”核对后再保存。', 'Conflict (REQUEST_CONFLICT): the remote changed, nothing was written. Reloaded; your draft is kept.')
        : formatRemoteError(err);
      if (err.code === 'REQUEST_CONFLICT') {
        // 先重读基线再提示，避免读取清掉冲突说明。
        await load(false);
        if (alive.current) setError(message);
      } else {
        setError(message);
      }
    } finally {
      if (alive.current) setBusy('');
    }
  }

  function openEditor(entry: CenterBotCapabilityEntry): void {
    setEditor({
      installationId: entry.installation.installationId,
      revision: entry.config.revision,
      enabled: entry.config.enabled,
      overrides: entry.config.overrides,
      text: flatFields(entry.config.configSchema) === null ? JSON.stringify(entry.config.overrides, null, 2) : null,
    });
    setError('');
    setNotice('');
  }

  function setOverride(key: string, value: JsonValue | undefined): void {
    setEditor((current) => {
      if (!current) return current;
      const overrides = { ...current.overrides };
      if (value === undefined) delete overrides[key];
      else overrides[key] = value;
      return { ...current, overrides };
    });
  }

  async function saveEditor(entry: CenterBotCapabilityEntry): Promise<void> {
    if (!editor) return;
    let overrides = editor.overrides;
    if (editor.text !== null) {
      if (editor.text.trim() === '') {
        setError(textRef.current('覆盖配置不能为空；不需要覆写请点“取消”（草稿已保留）。', 'Overrides JSON is empty; press Cancel to keep the saved config (your draft is kept).'));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(editor.text);
        if (!isObject(parsed)) throw new Error('overrides must be an object');
        overrides = parsed;
      } catch {
        setError(textRef.current('覆盖配置必须是合法 JSON 对象（草稿已保留，可修正后重试）。', 'Overrides must be a valid JSON object (draft kept; fix and retry).'));
        return;
      }
    }
    await save(entry, editor.enabled, overrides, editor.revision);
  }

  const statusText = (status: CenterRuntimeApplyStatus): string =>
    status === 'pending' ? t('等待下发', 'Pending')
      : status === 'applying' ? t('应用中', 'Applying')
        : status === 'waiting-idle' ? t('等待空闲', 'Waiting for idle')
          : status === 'applied' ? t('已生效', 'Applied')
            : t('应用失败', 'Failed');
  const kindText = (kind: string): string =>
    kind === 'plugin' ? t('插件', 'Plugin') : kind === 'mcp' ? 'MCP' : kind === 'skill' ? t('技能', 'Skill') : kind;
  const targetText = (target: string): string => (target === 'center' ? t('中心', 'Center') : 'Host');
  const globalStateText = (entry: CenterBotCapabilityEntry): string => {
    if (!entry.installation.enabled) return t('全局已关闭', 'disabled globally');
    const status: CenterCapabilityActivationStatus | undefined = entry.installation.activation?.status;
    if (status === 'enabled') return t('全局已启用', 'enabled globally');
    if (status === 'enabling') return t('全局启用中', 'enabling globally');
    if (status === 'failed') return t('全局启用失败', 'global activation failed');
    if (status === 'disabled') return t('全局未生效', 'globally inactive');
    return t('全局状态未确认', 'global state unknown');
  };
  const json = (value: unknown): string => (value === undefined ? t('默认', 'default') : JSON.stringify(value));
  const receipt = runtime?.bots?.find((item) => item.botId === botId);
  const capabilityErrors = runtime?.capabilityErrors?.filter((item) => item.botId === botId) ?? [];

  return (
    <section className="bot-cap" aria-label={t('Bot 能力', 'Bot capabilities')} style={{ display: 'grid', gap: 10 }}>
      {showTitle ? <h4 className="bot-cap-title" style={{ margin: 0 }}>{t('插件 / MCP / 技能', 'Plugins / MCP / skills')}</h4> : null}
      {runtime ? (
        <div className="bot-cap-runtime">
          <p className="metadata bot-cap-runtime-main" role="status">
            <span className={`bot-cap-dot ${runtime.online ? 'is-online' : 'is-offline'}`} aria-hidden="true" />
            {`${t('目标设备', 'Target')}: ${runtime.online ? t('在线', 'online') : t('离线', 'offline')} · ${t('应用状态', 'Status')}: ${statusText(runtime.status)}`}
          </p>
          <p className="metadata bot-cap-runtime-detail">
            {`${t('已下发', 'Desired')} revision ${runtime.desiredRevision ?? '—'} · ${t('已应用', 'Applied')} revision ${runtime.appliedRevision ?? '—'} · ${t('更新', 'Updated')} ${timeText(runtime.updatedAt)} · ${t('生效时间', 'Applied at')} ${timeText(runtime.appliedAt)}`}
          </p>
          {runtime.error ? <p className="bot-cap-error" role="alert">{`${runtime.error.code}: ${runtime.error.message}`}</p> : null}
          {receipt ? (
            <p className="metadata bot-cap-runtime-detail">
              {`${t('该 Bot', 'This bot')}: ${statusText(receipt.status)} · ${t('已应用', 'Applied')} revision ${receipt.appliedRevision ?? '—'}`}
            </p>
          ) : null}
          {capabilityErrors.map((item) => (
            <p className="bot-cap-error" role="alert" key={item.installationId}>{`${item.installationId}: ${item.error.code}`}</p>
          ))}
          {!runtime.online
            ? <p className="metadata bot-cap-runtime-detail">{t('目标离线：能力保存仍会写入中心，等设备上线后同步。', 'Target offline: saves still go to the center and sync when the device reconnects.')}</p>
            : null}
        </div>
      ) : null}

      {!loaded ? <p className="bot-cap-loading" role="status">{t('正在读取中心能力…', 'Loading capabilities…')}</p> : null}

      {needLogin ? (
        <form className="bot-cap-login" onSubmit={(event) => { event.preventDefault(); void login(); }}>
          <label className="bot-cap-field">
            <span className="bot-cap-field-label">{t('中心管理员密码', 'Center administrator password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="bot-cap-primary" type="submit" disabled={!password || busy !== ''}>{t('登录', 'Log in')}</button>
        </form>
      ) : null}

      {error ? <p className="bot-cap-error" role="alert">{error}</p> : null}
      {notice ? <p className="bot-cap-notice" role="status">{notice}</p> : null}

      {loaded && !needLogin && entries.length === 0
        ? <p className="metadata bot-cap-empty">{t('中心暂无可用于该 Bot 的能力。', 'No capability is available for this bot.')}</p>
        : null}

      {entries.map((entry) => {
        const { installation, config } = entry;
        const draft = editor?.installationId === installation.installationId ? editor : null;
        const fields = flatFields(config.configSchema);
        return (
          <section
            key={installation.installationId}
            className={`bot-cap-item${config.enabled ? ' is-enabled' : ''}`}
            role="group"
            aria-label={installation.displayName}
            style={{ display: 'grid', gap: 6 }}
          >
            <p className="bot-cap-item-head">
              <strong>{installation.displayName}</strong>
              <span className="bot-cap-item-tags">{` · ${kindText(installation.kind)} · ${targetText(installation.target)}`}</span>
            </p>
            <p className="metadata bot-cap-item-global">
              {`${globalStateText(entry)} · ${t('全局更新', 'global updated')} ${timeText(installation.activation?.updatedAt ?? null)}`}
            </p>
            {installation.activation?.error
              ? <p className="bot-cap-error" role="alert">{`${installation.activation.error.code}: ${installation.activation.error.message}`}</p>
              : null}
            <label className="bot-cap-toggle">
              <input
                type="checkbox"
                checked={config.enabled}
                disabled={busy !== '' || (!config.enabled && !globallyReady(entry))}
                onChange={(event) => {
                  const next = event.target.checked;
                  // 不得用 Bot 开关打开全局；全局未生效时拒绝开启，但允许关闭。
                  if (next && !globallyReady(entry)) {
                    setError(t('该能力全局未启用（或启用未完成），不能为本 Bot 开启；请先在中心启用并等待生效。', 'The capability is not enabled globally yet; enable it in the center first.'));
                    return;
                  }
                  void save(entry, next, config.overrides, config.revision);
                }}
              />
              <span className="bot-cap-toggle-text">{t('为该 Bot 启用', 'Enable for this bot')}</span>
            </label>
            {!globallyReady(entry) && !config.enabled
              ? <p className="metadata bot-cap-item-note">{t('全局未生效：本 Bot 无法开启该能力，请先在中心启用并等待生效。', 'Not active globally: this bot cannot switch it on until the center enables it.')}</p>
              : null}
            {config.enabled && !globallyReady(entry)
              ? <p className="metadata bot-cap-item-note">{t('当前不生效：本 Bot 偏好已保留，全局生效后会重新加载。', 'Currently inactive: the bot preference is kept and loads again once the global capability is active.')}</p>
              : null}
            <p className="metadata bot-cap-item-note">
              {Object.keys(config.overrides).length
                ? t('已覆写本 Bot 配置', 'Bot overrides configured')
                : t('继承全局配置', 'Inherits global config')}
            </p>
            {draft === null ? (
              <button className="bot-cap-secondary" type="button" disabled={busy !== ''} onClick={() => openEditor(entry)}>
                {t('配置本 Bot', 'Configure for this bot')}
              </button>
            ) : (
              <div className="bot-cap-editor" style={{ display: 'grid', gap: 6 }}>
                {fields === null ? (
                  <label className="bot-cap-field">
                    {t('覆盖配置 JSON（整段覆写，数组整体替换）', 'Overrides JSON (whole-value; arrays replace)')}
                    <textarea
                      rows={6}
                      spellCheck={false}
                      value={draft.text ?? ''}
                      disabled={busy !== ''}
                      onChange={(event) => {
                        const text = event.target.value;
                        setEditor((current) => (current ? { ...current, text } : current));
                      }}
                    />
                  </label>
                ) : fields.length === 0 ? (
                  <p className="metadata bot-cap-item-note">{t('该能力没有可配置项。', 'This capability has no configurable field.')}</p>
                ) : fields.map((field) => {
                  const overridden = field.key in draft.overrides;
                  const value = draft.overrides[field.key];
                  return (
                    <div className="bot-cap-override" key={field.key}>
                      <label className="bot-cap-override-head">
                        <input
                          type="checkbox"
                          checked={overridden}
                          disabled={busy !== ''}
                          onChange={(event) => setOverride(field.key, event.target.checked ? config.globalConfig[field.key] ?? null : undefined)}
                        />
                        {`${field.key} · ${overridden ? t('覆写', 'override') : t('继承全局', 'inherit')} (${json(config.globalConfig[field.key])})`}
                      </label>
                      {!overridden ? null : field.kind === 'boolean' ? (
                        <select
                          value={value === true ? 'true' : 'false'}
                          disabled={busy !== ''}
                          onChange={(event) => setOverride(field.key, event.target.value === 'true')}
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : field.kind === 'enum' ? (
                        <select
                          value={typeof value === 'string' ? value : ''}
                          disabled={busy !== ''}
                          onChange={(event) => setOverride(field.key, event.target.value)}
                        >
                          <option value="">—</option>
                          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ) : (
                        <input
                          type={field.kind === 'number' ? 'number' : 'text'}
                          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                          disabled={busy !== ''}
                          onChange={(event) => setOverride(field.key, field.kind === 'number'
                            ? (event.target.value === '' ? undefined : Number(event.target.value))
                            : event.target.value)}
                        />
                      )}
                    </div>
                  );
                })}
                <div className="bot-cap-actions">
                  <button className="bot-cap-primary" type="button" disabled={busy !== ''} onClick={() => void saveEditor(entry)}>
                    {t('保存', 'Save')}
                  </button>
                  <button className="bot-cap-secondary" type="button" disabled={busy !== ''} onClick={() => setEditor(null)}>
                    {t('取消', 'Cancel')}
                  </button>
                  <button
                    className="bot-cap-secondary"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => {
                      // 显式采用远端：只有这个动作会替换草稿内容与 CAS 基线。
                      setEditor({
                        installationId: installation.installationId,
                        revision: config.revision,
                        enabled: config.enabled,
                        overrides: config.overrides,
                        text: fields === null ? JSON.stringify(config.overrides, null, 2) : null,
                      });
                      setError('');
                    }}
                  >
                    {t('采用远端（丢弃草稿）', 'Adopt remote (discard draft)')}
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
