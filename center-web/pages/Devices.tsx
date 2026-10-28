import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BotModelConfig, BotRef, BotSyncResponse, Device, ModelConfig, ModelSelection, Provider } from '@e-launcher/center-contract';
import { api } from '../api';

const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
interface ModelOption { ref: string; name: string }

function compareBots(a: BotRef, b: BotRef): number {
  const aArchived = Boolean(a.archivedAt);
  const bArchived = Boolean(b.archivedAt);
  if (aArchived !== bArchived) return aArchived ? 1 : -1;
  const aPrimary = a.isPrimary === true;
  const bPrimary = b.isPrimary === true;
  if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
  const aTime = Date.parse(a.lastActivityAt ?? a.createdAt ?? '') || 0;
  const bTime = Date.parse(b.lastActivityAt ?? b.createdAt ?? '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return a.botId.localeCompare(b.botId);
}

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

function CreateBotForm({
  online,
  busy,
  defaultPrimary,
  forcePrimary,
  onSubmit,
  onCancel,
}: {
  online: boolean;
  busy: boolean;
  defaultPrimary: boolean;
  forcePrimary?: boolean;
  onSubmit(input: { role: string; description: string; cwd?: string; makePrimary: boolean }): void;
  onCancel?: () => void;
}) {
  const [role, setRole] = useState('');
  const [description, setDescription] = useState('');
  const [cwd, setCwd] = useState('');
  const [makePrimary, setMakePrimary] = useState(defaultPrimary || Boolean(forcePrimary));
  useEffect(() => {
    if (forcePrimary) setMakePrimary(true);
  }, [forcePrimary]);
  const disabled = busy || !online;
  return (
    <form
      className="form"
      onSubmit={e => {
        e.preventDefault();
        if (!role.trim() || disabled) return;
        onSubmit({
          role: role.trim(),
          description: description.trim(),
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          makePrimary: forcePrimary ? true : makePrimary,
        });
        setRole('');
        setDescription('');
        setCwd('');
      }}
    >
      {!online && <p className="secondary danger">设备离线，无法远程创建 Bot</p>}
      <label>
        名称
        <input value={role} onChange={e => setRole(e.target.value)} placeholder="输入 Bot 名称" required disabled={disabled} />
      </label>
      <label>
        描述
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="职责或说明（可选）" disabled={disabled} />
      </label>
      <label>
        工作目录 (cwd，可选)
        <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="留空使用主机默认工作空间" disabled={disabled} />
      </label>
      {!forcePrimary && (
        <label className="check">
          <input type="checkbox" checked={makePrimary} onChange={e => setMakePrimary(e.target.checked)} disabled={disabled} />
          <span>设为主 Bot</span>
        </label>
      )}
      <div className="action-row">
        <button className="button" type="submit" disabled={disabled || !role.trim()}>
          {forcePrimary ? '创建主 Bot' : '创建 Bot'}
        </button>
        {onCancel && (
          <button className="quiet-button" type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [bots, setBots] = useState<Record<string, BotRef[]>>({});
  const [global, setGlobal] = useState<ModelConfig>();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<{ device: Device; bot: BotRef; config: BotModelConfig }>();
  const [expandedCreate, setExpandedCreate] = useState<Record<string, boolean>>({});
  const [editingBot, setEditingBot] = useState<{ deviceId: string; botId: string; name: string; description: string }>();
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const syncCursorRef = useRef<{ epoch?: string; seq?: number }>({});

  const applyBotSync = (sync: BotSyncResponse) => {
    syncCursorRef.current = { epoch: sync.epoch, seq: sync.seq };
    setDevices(sync.devices);
    if (sync.mode === 'snapshot') {
      const grouped: Record<string, BotRef[]> = {};
      for (const d of sync.devices) grouped[d.deviceId] = [];
      for (const b of sync.bots || []) {
        (grouped[b.deviceId] ||= []).push(b);
      }
      for (const list of Object.values(grouped)) list.sort(compareBots);
      setBots(grouped);
    } else if (sync.events?.length) {
      setBots(prev => {
        const next: Record<string, BotRef[]> = {};
        for (const [k, v] of Object.entries(prev)) next[k] = [...v];
        for (const d of sync.devices) if (!next[d.deviceId]) next[d.deviceId] = [];
        for (const ev of sync.events || []) {
          const list = next[ev.deviceId] ? [...next[ev.deviceId]] : [];
          if (ev.op === 'upsert' && ev.bot) {
            const idx = list.findIndex(item => item.botId === ev.botId);
            if (idx >= 0) list[idx] = ev.bot;
            else list.push(ev.bot);
          } else if (ev.op === 'delete') {
            const idx = list.findIndex(item => item.botId === ev.botId);
            if (idx >= 0) list.splice(idx, 1);
          }
          list.sort(compareBots);
          next[ev.deviceId] = list;
        }
        return next;
      });
    }
  };

  const syncBotsNow = async () => {
    const sync = await api.getBotSync({
      epoch: syncCursorRef.current.epoch,
      sinceSeq: syncCursorRef.current.seq,
    });
    applyBotSync(sync);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    const [sync, g, providers] = await Promise.all([
      api.getBotSync({ epoch: syncCursorRef.current.epoch, sinceSeq: syncCursorRef.current.seq }),
      api.getModelConfig(),
      api.listProviders(),
    ]);
    const modelLists = await Promise.all(providers.map((p: Provider) => api.listModels(p.id)));
    applyBotSync(sync);
    setGlobal(g);
    setOptions(modelLists.flatMap((models, i) => providers[i].enabled ? models.filter(m => m.enabled).map(m => ({ ref: `${providers[i].id}/${m.id}`, name: m.name })) : []));
  };

  useEffect(() => {
    void run(load);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void api.getBotSync({
        epoch: syncCursorRef.current.epoch,
        sinceSeq: syncCursorRef.current.seq,
      }).then(applyBotSync).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main className="page">
      <header className="page-header">
        <h1>设备与 Bot 管理</h1>
        <button className="quiet-button" disabled={busy} onClick={() => void run(load)}>刷新</button>
      </header>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {global && (
        <section className="panel">
          <h2>全局模型</h2>
          <SelectionForm
            value={global.global}
            options={options}
            busy={busy}
            save={value => void run(async () => {
              setGlobal(await api.putModelConfig({ expectedRevision: global.revision, value }));
              setNotice('全局模型已保存');
              if (selected) setSelected({ ...selected, config: await api.getBotModelConfig(selected.device.deviceId, selected.bot.botId) });
            })}
          />
        </section>
      )}
      {devices.map(device => {
        const allBots = (bots[device.deviceId] || []).slice().sort(compareBots);
        const activeBots = allBots.filter(b => !b.archivedAt);
        const archivedBots = allBots.filter(b => Boolean(b.archivedAt));
        const hasPrimary = activeBots.some(b => b.isPrimary);
        const createOpen = Boolean(expandedCreate[device.deviceId]);

        return (
          <section className="resource-row" key={device.deviceId}>
            <div className="action-row">
              <h2>{device.name || device.deviceId}</h2>
              <span className="secondary">{device.deviceId} · {device.online ? '在线' : '离线（离线设备禁用远程管理）'}</span>
              <button
                className="quiet-button"
                disabled={busy || !device.online}
                title={!device.online ? '设备离线，不可新建 Bot' : undefined}
                onClick={() => setExpandedCreate(prev => ({ ...prev, [device.deviceId]: !prev[device.deviceId] }))}
              >
                {createOpen ? '收起新建 Bot' : '新建 Bot'}
              </button>
            </div>

            {!hasPrimary && (
              <div className="panel">
                <p className="danger"><strong>未设置主 Bot</strong> — 请为该设备创建或指定一个主 Bot</p>
                <CreateBotForm
                  online={device.online}
                  busy={busy}
                  defaultPrimary={true}
                  forcePrimary={true}
                  onSubmit={input => void run(async () => {
                    await api.createBot(device.deviceId, input);
                    await syncBotsNow();
                    setNotice('主 Bot 已创建');
                  })}
                />
              </div>
            )}

            {createOpen && (
              <div className="panel">
                <h3>新建 Bot</h3>
                <CreateBotForm
                  online={device.online}
                  busy={busy}
                  defaultPrimary={!hasPrimary}
                  onCancel={() => setExpandedCreate(prev => ({ ...prev, [device.deviceId]: false }))}
                  onSubmit={input => void run(async () => {
                    await api.createBot(device.deviceId, input);
                    await syncBotsNow();
                    setExpandedCreate(prev => ({ ...prev, [device.deviceId]: false }));
                    setNotice('Bot 已创建');
                  })}
                />
              </div>
            )}

            {activeBots.map(bot => {
              const botKey = `${device.deviceId}:${bot.botId}`;
              const isEditing = editingBot?.deviceId === device.deviceId && editingBot?.botId === bot.botId;
              const isConfirmingDelete = confirmDeleteKey === botKey;
              const activityTime = bot.lastActivityAt ?? bot.createdAt;

              return (
                <div className="bot-row" key={bot.botId}>
                  <div>
                    <strong>{bot.name || bot.botId}</strong>
                    {bot.isPrimary && <span>★ 主 Bot</span>}
                    <span className="secondary">{bot.botId}</span>
                  </div>
                  {bot.description && <p className="secondary">{bot.description}</p>}
                  <p className="secondary">
                    最后活动：{activityTime ? new Date(activityTime).toLocaleString() : '暂无记录'}
                    {bot.lastPreview ? ` · 摘要：${bot.lastPreview}` : ''}
                  </p>

                  {isEditing && editingBot && (
                    <form
                      className="form"
                      onSubmit={e => {
                        e.preventDefault();
                        if (!editingBot.name.trim()) return;
                        void run(async () => {
                          await api.updateBot(device.deviceId, bot.botId, {
                            name: editingBot.name.trim(),
                            description: editingBot.description,
                          });
                          await syncBotsNow();
                          setEditingBot(undefined);
                          setNotice('Bot 资料已更新');
                        });
                      }}
                    >
                      <label>
                        名称
                        <input value={editingBot.name} onChange={e => setEditingBot({ ...editingBot, name: e.target.value })} required disabled={busy || !device.online} />
                      </label>
                      <label>
                        描述
                        <input value={editingBot.description} onChange={e => setEditingBot({ ...editingBot, description: e.target.value })} disabled={busy || !device.online} />
                      </label>
                      <div className="action-row">
                        <button className="button" type="submit" disabled={busy || !device.online || !editingBot.name.trim()}>保存</button>
                        <button className="quiet-button" type="button" onClick={() => setEditingBot(undefined)}>取消</button>
                      </div>
                    </form>
                  )}

                  <div className="action-row">
                    {!bot.isPrimary && (
                      <button
                        className="quiet-button"
                        disabled={busy || !device.online}
                        title={!device.online ? '设备离线' : undefined}
                        onClick={() => void run(async () => {
                          await api.setPrimaryBot(device.deviceId, bot.botId);
                          await syncBotsNow();
                          setNotice(`已将 ${bot.name || bot.botId} 设为主 Bot`);
                        })}
                      >
                        设为主 Bot
                      </button>
                    )}
                    <button
                      className="quiet-button"
                      disabled={busy || !device.online}
                      title={!device.online ? '设备离线' : undefined}
                      onClick={() => setEditingBot({
                        deviceId: device.deviceId,
                        botId: bot.botId,
                        name: bot.name || '',
                        description: bot.description || '',
                      })}
                    >
                      重命名/编辑描述
                    </button>
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => void run(async () => {
                        setSelected({ device, bot, config: await api.getBotModelConfig(device.deviceId, bot.botId) });
                      })}
                    >
                      模型配置
                    </button>
                    <Link to={`/devices/${encodeURIComponent(device.deviceId)}/bots/${encodeURIComponent(bot.botId)}/capabilities`}>能力分配</Link>
                    <button
                      className="quiet-button"
                      disabled={busy || !device.online || Boolean(bot.isPrimary)}
                      title={bot.isPrimary ? '主 Bot 不可归档' : !device.online ? '设备离线' : undefined}
                      onClick={() => void run(async () => {
                        await api.archiveBot(device.deviceId, bot.botId);
                        await syncBotsNow();
                        setNotice(`已归档 ${bot.name || bot.botId}`);
                      })}
                    >
                      归档
                    </button>
                    {!isConfirmingDelete ? (
                      <button
                        className="quiet-button danger"
                        disabled={busy || !device.online || Boolean(bot.isPrimary)}
                        title={bot.isPrimary ? '主 Bot 不可删除' : !device.online ? '设备离线' : undefined}
                        onClick={() => setConfirmDeleteKey(botKey)}
                      >
                        删除
                      </button>
                    ) : (
                      <>
                        <button
                          className="quiet-button danger"
                          disabled={busy || !device.online}
                          onClick={() => void run(async () => {
                            await api.deleteBot(device.deviceId, bot.botId);
                            await syncBotsNow();
                            setConfirmDeleteKey(undefined);
                            setNotice(`已删除 ${bot.name || bot.botId}`);
                          })}
                        >
                          确认删除
                        </button>
                        <button className="quiet-button" onClick={() => setConfirmDeleteKey(undefined)}>取消</button>
                      </>
                    )}
                    {bot.isPrimary && <small className="secondary">（主 Bot 不可归档 · 主 Bot 不可删除）</small>}
                  </div>
                </div>
              );
            })}

            {!activeBots.length && <p className="secondary">暂无未归档 Bot</p>}

            {archivedBots.length > 0 && (
              <details>
                <summary className="quiet-button">已归档 Bot ({archivedBots.length})</summary>
                {archivedBots.map(bot => {
                  const remainingDays = Math.max(0, Math.ceil(14 - (Date.now() - Date.parse(bot.archivedAt!)) / 86400000));
                  return (
                    <div className="bot-row" key={bot.botId}>
                      <div>
                        <strong>{bot.name || bot.botId}</strong>
                        <span className="secondary">{bot.botId}</span>
                        <span className="secondary">剩余 {remainingDays} 天自动删除</span>
                      </div>
                      {bot.description && <p className="secondary">{bot.description}</p>}
                      <div className="action-row">
                        <button
                          className="quiet-button"
                          disabled={busy || !device.online}
                          title={!device.online ? '设备离线' : undefined}
                          onClick={() => void run(async () => {
                            await api.unarchiveBot(device.deviceId, bot.botId);
                            await syncBotsNow();
                            setNotice(`已恢复 ${bot.name || bot.botId}`);
                          })}
                        >
                          恢复
                        </button>
                        <button
                          className="quiet-button danger"
                          disabled={busy || !device.online}
                          title={!device.online ? '设备离线' : undefined}
                          onClick={() => void run(async () => {
                            await api.deleteBot(device.deviceId, bot.botId);
                            await syncBotsNow();
                            setNotice(`已删除 ${bot.name || bot.botId}`);
                          })}
                        >
                          立即删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </details>
            )}
          </section>
        );
      })}
      {selected && (
        <section className="panel">
          <h2>{selected.bot.name || selected.bot.botId} 的模型覆盖</h2>
          <p className="secondary">当前有效模型：{selected.config.effective.modelRef ?? '未选择'} · 思考档位 {selected.config.effective.thinkingLevel ?? '未设置'}</p>
          <SelectionForm
            value={selected.config.overrides}
            inherited={selected.config.global}
            options={options}
            busy={busy}
            save={value => void run(async () => {
              const config = await api.putBotModelConfig(selected.device.deviceId, selected.bot.botId, { expectedRevision: selected.config.revision, value });
              setSelected({ ...selected, config });
              setNotice('Bot 模型覆盖已保存');
            })}
          />
          <button className="quiet-button" onClick={() => setSelected(undefined)}>关闭</button>
        </section>
      )}
    </main>
  );
}
