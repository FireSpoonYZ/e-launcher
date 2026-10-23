import { useCallback, useEffect, useRef, useState } from 'react';
import { BotHost, type HostBot, type HostFrameEvent, type HostHistoryPage, type HostLiveFrame, type HostPhase, type HostSettings, type HostSettingsPayload, type HostSnapshot, type HostSubmission, type HostVoiceEvent, type HostVoiceRemote, type HostVoiceSaveInput, type HostVoiceSettings } from './native';
import { Dialog } from './components/ui/dialog';
import { ErrorNotice, Header, Row, Section, useAction, useText, array, errorText, record } from './ui';
import { HostLegacyImport } from './HostLegacyImport';

type Home = (zh: string, en: string) => string;

type PendingText = { kind: 'text'; botId: string; requestId: string; text: string };
type PendingCreate = { kind: 'create'; requestId: string; role: string; cwd: string; modelRef: string | null };
type Pending = PendingText | PendingCreate;
type LifecycleShape = {target:'running'|'stopped'; since:number; deadline:number};

const uuid = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const phaseLabel = (phase: HostPhase, t: Home) => ({
  stopped: t('已停止','Stopped'),
  starting: t('启动中','Starting'),
  running: t('运行中','Running'),
  stopping: t('停止中','Stopping'),
  failed: t('失败','Failed'),
}[phase]);
// Restore only validated pending records; drop anything malformed.
const parsePending = (value: unknown): Pending | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = record(value);
  if (raw.kind === 'text' && typeof raw.botId === 'string' && typeof raw.requestId === 'string' && typeof raw.text === 'string') {
    return {kind:'text', botId: raw.botId, requestId: raw.requestId, text: raw.text};
  }
  if (raw.kind === 'create' && typeof raw.requestId === 'string' && typeof raw.role === 'string' && typeof raw.cwd === 'string') {
    return {kind:'create', requestId: raw.requestId, role: raw.role, cwd: raw.cwd, modelRef: typeof raw.modelRef === 'string' ? raw.modelRef : null};
  }
  return undefined;
};
const liveSummary = (frame: HostLiveFrame): string => {
  if (frame.type === 'end') return `end · ${frame.reason ?? ''}`;
  const state = frame.type === 'snapshot' ? frame.state : frame.changes;
  const parts: string[] = [];
  if (state?.busy === true) parts.push('busy');
  if (typeof state?.queuedCount === 'number' && state.queuedCount > 0) parts.push(`queued ${state.queuedCount}`);
  const generation = state?.generation as {text?: string; truncated?: boolean} | null | undefined;
  if (generation?.text) parts.push(generation.truncated ? `${generation.text}…` : generation.text);
  return parts.join(' · ') || '—';
};
// History items are EntryRecords; render only user/assistant text, never raw tool/thinking payload.
const historyEntry = (item: Record<string, unknown>): string => {
  const model = array<unknown>(item.model);
  return model.map(message => {
    if (typeof message === 'string') return message;
    const entry = record(message);
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') return '';
    const content = entry.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(block => {
        if (typeof block === 'string') return block;
        const part = record(block);
        return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
      }).filter(Boolean).join(' ');
    }
    return '';
  }).filter(Boolean).join(' ');
};
const receiptDetail = (receipt: HostSubmission): string =>
  [receipt.status, receipt.answerText ?? '', receipt.reason ?? '', receipt.requestId].filter(Boolean).join(' · ');
const voiceEventText = (event: HostVoiceEvent, t: Home): string => {
  if (event.type === 'partial') return `${t('转录中','Partial')}: ${event.text ?? ''}`;
  if (event.type === 'submitted') {
    const status = typeof event.receipt?.status === 'string' ? event.receipt.status : '';
    return `${t('已提交','Submitted')}: ${[status, event.receipt?.requestId ?? event.requestId].filter(Boolean).join(' · ')}`;
  }
  return `${t('错误','Error')}: ${[event.code ?? '', event.outcome ?? '', event.message ?? ''].filter(Boolean).join(' · ')}`;
};
const remoteDetail = (remote: HostVoiceRemote, t: Home): string =>
  remote.baseUrl ? `${remote.model} · ${remote.baseUrl}${remote.hasApiKey ? ` · ${t('已保存 API Key','API key saved')}` : ''}` : t('未配置','Not configured');
const rates = [0.75, 1, 1.25, 1.5, 2];

export function HostPage() {
  const t = useText(); const action = useAction();
  const [host, setHost] = useState<HostSnapshot>();
  const [snapshotError, setSnapshotError] = useState('');
  const [bots, setBots] = useState<HostBot[]>();
  const [selected, setSelected] = useState<HostBot>();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending>();
  const [storageNotice, setStorageNotice] = useState('');
  const [receipt, setReceipt] = useState<HostSubmission>();
  const [observeId, setObserveId] = useState<string>();
  const [live, setLive] = useState<HostLiveFrame>();
  const [frames, setFrames] = useState<HostFrameEvent[]>([]);
  const [history, setHistory] = useState<HostHistoryPage>();
  const [settings, setSettings] = useState<HostSettingsPayload>();
  const [settingsDraft, setSettingsDraft] = useState('');
  const [credDraft, setCredDraft] = useState('');
  const [voice, setVoice] = useState<HostVoiceSettings>();
  const [capture, setCapture] = useState<{botId:string; requestId:string}>();
  const [voiceEvents, setVoiceEvents] = useState<HostVoiceEvent[]>([]);
  const [remoteKind, setRemoteKind] = useState<'stt'|'tts'>();
  const [createReqId, setCreateReqId] = useState(() => uuid());
  const [role, setRole] = useState('');
  const [cwd, setCwd] = useState('');
  const [modelRef, setModelRef] = useState('');
  const observeIdRef = useRef<string | undefined>(undefined);
  const captureRef = useRef<{botId:string; requestId:string} | undefined>(undefined);
  const selectedRef = useRef<HostBot | undefined>(undefined);
  const listenersReady = useRef<Promise<void>>(Promise.resolve());
  captureRef.current = capture;
  selectedRef.current = selected;
  // Single pending lifecycle request; one effect-owned observer polls snapshots
  // until it is replaced (opposite direction) or removed (done/timeout).
  const [lifecycle, setLifecycle] = useState<LifecycleShape>();
  const [lifecycleNotice, setLifecycleNotice] = useState('');
  const lifecycleRef = useRef<LifecycleShape | undefined>(undefined);

  const refreshSnapshot = async () => {
    try {
      const snap = await BotHost.snapshot();
      setHost(snap); setSnapshotError('');
      // Page opened/mid-transit with no pending request: re-attach the same
      // observer read-only (never sends start/stop).
      if ((snap.phase === 'starting' || snap.phase === 'stopping') && !lifecycleRef.current) {
        const req = {target: snap.phase === 'starting' ? 'running' as const : 'stopped' as const, since: snap.lastUpdated, deadline: Date.now() + 60000};
        lifecycleRef.current = req;
        setLifecycle(req);
      }
    } catch (error) { setSnapshotError(errorText(error)); }
  };
  useEffect(() => {
    if (!lifecycle) return;
    let alive = true;
    let attempts = 0;
    let timer = 0;
    let inFlight = false;
    const wait = t('等待状态确认…','Waiting for status…');
    const timeoutMsg = t('等待超时，已显示最后快照；可点“刷新”对账。','Timed out waiting; showing the last snapshot. Use Refresh to reconcile.');
    setLifecycleNotice(wait);
    const settle = (timedOut?: boolean) => {
      // Only the observer owning the current request may complete it; a newer
      // opposite request (or unmount) must never be cleared by a stale one.
      if (!alive || lifecycleRef.current !== lifecycle) return;
      lifecycleRef.current = undefined;
      setLifecycle(undefined);
      setLifecycleNotice(timedOut ? timeoutMsg : '');
    };
    const expired = () => Date.now() >= lifecycle.deadline || attempts >= 60;
    const schedule = () => {
      if (!alive || lifecycleRef.current !== lifecycle || inFlight) return;
      window.clearTimeout(timer); timer = 0;
      if (expired()) {
        // Hidden expiry: stop the timer quietly; the visibility event reconciles.
        if (!document.hidden) settle(true);
        return;
      }
      timer = window.setTimeout(tick, 1000);
    };
    const tick = async () => {
      if (!alive || lifecycleRef.current !== lifecycle || inFlight) return;
      // One chain only: drop any leftover timer before starting a new cycle.
      window.clearTimeout(timer); timer = 0;
      // Bounds first at every tick/schedule; failed attempts count too.
      if (expired()) { if (!document.hidden) settle(true); return; }
      if (document.hidden) { schedule(); return; }
      inFlight = true;
      let snap: HostSnapshot;
      try { snap = await BotHost.snapshot(); } catch { inFlight = false; attempts++; schedule(); return; }
      inFlight = false;
      // Re-check after the await: unmounted, stale observer, or hidden mid-read
      // must not update.
      if (!alive || lifecycleRef.current !== lifecycle) return;
      if (document.hidden) { schedule(); return; }
      attempts++;
      setHost(snap); setSnapshotError('');
      // Target phase completes regardless of timestamp; FAILED counts only when
      // lastUpdated changed since the request (not a previous failure).
      const done = (lifecycle.target === 'running' && snap.phase === 'running') ||
        (lifecycle.target === 'stopped' && snap.phase === 'stopped') ||
        (snap.phase === 'failed' && snap.lastUpdated !== lifecycle.since);
      if (done) { settle(); return; }
      schedule();
    };
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [lifecycle]);
  // On mount only read the cold snapshot; never start/read settings/model.
  useEffect(() => { void refreshSnapshot(); }, []);
  useEffect(() => { if (host?.workspace && !cwd) setCwd(host.workspace); }, [host?.workspace]);

  const clearObserveId = useCallback(() => { observeIdRef.current = undefined; setObserveId(undefined); }, []);
  const cancelObserve = useCallback(() => {
    const id = observeIdRef.current;
    if (!id) return;
    clearObserveId();
    void BotHost.cancelObservation({observationId: id}).catch(() => {});
  }, [clearObserveId]);
  const clearCapture = useCallback((cap: {botId:string; requestId:string}) => {
    if (captureRef.current !== cap) return; // identity-guarded: only this capture
    captureRef.current = undefined;
    setCapture(undefined);
  }, []);
  const cancelCaptureVoice = useCallback((cap: {botId:string; requestId:string}) => {
    if (captureRef.current !== cap) return;
    void BotHost.cancelVoice().catch(() => {});
    clearCapture(cap);
  }, [clearCapture]);

  // Frozen pending survives reload via a dedicated sessionStorage key (no credentials).
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('bot-host-pending');
      if (saved) {
        const restored = parsePending(JSON.parse(saved));
        if (restored) setPending(restored);
      }
    } catch { /* drop invalid storage */ }
  }, []);
  useEffect(() => {
    try {
      if (pending) sessionStorage.setItem('bot-host-pending', JSON.stringify(pending));
      else sessionStorage.removeItem('bot-host-pending');
      setStorageNotice('');
    } catch { setStorageNotice(t('无法保存本地待确认记录（存储不可用）','Unable to save pending record locally (storage unavailable)')); }
  }, [pending]);

  // Listeners register (and are awaited before observe) so no event is missed.
  // Registration rejection is surfaced through listenersReady (action.run shows
  // it); a successful registration still retains/cleans its handle because
  // Promise.all rejection does not cancel sibling promises. Exactly this page's
  // handles are removed on cleanup/late success.
  useEffect(() => {
    let alive = true;
    const handles: Array<{remove(): void}> = [];
    const retainHandle = (handle: {remove(): void}) => {
      if (!alive) { handle.remove(); return; }
      handles.push(handle);
    };
    const hostListener = (event: HostFrameEvent) => {
      if (!alive || event.observationId !== observeIdRef.current) return;
      setFrames(f => [...f.slice(-9), event]);
      if (event.error) { clearObserveId(); setLive(undefined); return; }
      const frame = event.frame;
      if (!frame) return;
      if (frame.type === 'snapshot') setLive(frame);
      else if (frame.type === 'update') {
        setLive(prev => prev && prev.type !== 'end'
          ? {...prev, state: {...(prev.state ?? {}), ...(frame.changes ?? {})} as HostLiveFrame['state']}
          : prev);
      } else if (frame.type === 'end') { setLive(frame); clearObserveId(); }
    };
    const voiceListener = (event: HostVoiceEvent) => {
      if (!alive) return;
      setVoiceEvents(v => [...v.slice(-9), event]);
      const cap = captureRef.current;
      // Only the terminal event for the current capture may clear it. Never
      // clear the independent text draft or an unmatched pending.
      const matches = !!cap && event.botId === cap.botId && event.requestId === cap.requestId;
      if (event.type === 'submitted') {
        if (matches) {
          clearCapture(cap);
          // Clear only the pending whose requestId matches this capture.
          setPending(prev => prev?.kind === 'text' && prev.requestId === cap.requestId ? undefined : prev);
        }
      } else if (event.type === 'error') {
        if (!matches) return;
        clearCapture(cap);
        // Frozen transcript payload only when the error actually carries final text.
        if (event.text && event.text.length > 0) {
          setPending({kind:'text', botId: event.botId, requestId: event.requestId, text: event.text});
        }
      }
    };
    listenersReady.current = Promise.all([
      BotHost.addListener('hostFrame', hostListener).then(retainHandle),
      BotHost.addListener('voiceEvent', voiceListener).then(retainHandle),
    ]).then(() => undefined);
    // Keep the rejection for readiness consumers; suppress only the unhandled
    // rejection warning at mount without replacing the resolved value.
    void listenersReady.current.catch(() => {});
    return () => {
      alive = false;
      handles.forEach(handle => handle.remove());
    };
  }, [clearObserveId]);

  // Cancel owned observer and voice capture on page leave/hidden; never Agent abort.
  // Cleanup immediately clears the UI capture state too, so no lingering
  // “recording” label survives navigation/hide.
  useEffect(() => () => { cancelObserve(); if (captureRef.current) cancelCaptureVoice(captureRef.current); }, [cancelObserve, cancelCaptureVoice]);
  useEffect(() => {
    const onHidden = () => {
      if (!document.hidden) return;
      // Native permission dialogs do not hide the page, so this only fires on
      // real page hide; cancel voice + clear UI capture there and then.
      if (captureRef.current) cancelCaptureVoice(captureRef.current);
      cancelObserve(); // Native onPause already closes observations; clear client id too
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [cancelObserve, cancelCaptureVoice]);


  const startHost = () => {
    if (lifecycle?.target === 'running') return; // one same-direction request at a time
    const since = host?.lastUpdated ?? -1;
    const req = {target:'running' as const, since, deadline: Date.now() + 60000};
    lifecycleRef.current = req;
    setLifecycle(req);
    void action.run(async () => {
      try { await BotHost.start(); }
      catch (error) {
        // ACK rejected: clear only this request, never a later opposite one.
        if (lifecycleRef.current === req) {
          lifecycleRef.current = undefined;
          setLifecycle(undefined);
          setLifecycleNotice('');
        }
        throw error; // action.run displays it
      }
    });
  };
  const stopHost = () => {
    if (lifecycle?.target === 'stopped') return; // one same-direction request at a time
    const since = host?.lastUpdated ?? -1;
    const req = {target:'stopped' as const, since, deadline: Date.now() + 60000};
    lifecycleRef.current = req;
    setLifecycle(req);
    void action.run(async () => {
      try { await BotHost.stop(); }
      catch (error) {
        // ACK rejected: clear only this request, never a later opposite one.
        if (lifecycleRef.current === req) {
          lifecycleRef.current = undefined;
          setLifecycle(undefined);
          setLifecycleNotice('');
        }
        throw error; // action.run displays it
      }
    });
  };
  const listBots = () => action.run(async () => {
    const envelope = await BotHost.call({method:'listBots', params:{}});
    setBots(array<HostBot>(envelope.result));
  });
  const createBot = () => action.run(async () => {
    if (captureRef.current || pending) return; // single pending design: no parallel input
    if (!role.trim() || !cwd.trim()) return;
    const payload: PendingCreate = {kind:'create', requestId: createReqId, role, cwd, modelRef: modelRef.trim() || null};
    setPending(payload);
    const envelope = await BotHost.call({method:'createBot', params:{requestId: payload.requestId, role: payload.role, cwd: payload.cwd, modelRef: payload.modelRef}});
    setSelected(envelope.result as HostBot);
    setPending(undefined);
    setCreateReqId(uuid());
    const list = await BotHost.call({method:'listBots', params:{}});
    setBots(array<HostBot>(list.result));
  });
  const chooseBot = (bot: HostBot) => action.run(async () => {
    if (captureRef.current) return;
    cancelObserve();
    setSelected(bot);
    setReceipt(undefined);
    setLive(undefined);
    setHistory(undefined);
  });
  const submit = () => action.run(async () => {
    if (captureRef.current) return; // single pending design: no parallel input
    if (!selected || !draft.trim() || pending) return;
    const payload: PendingText = {kind:'text', botId: selected.botId, requestId: uuid(), text: draft};
    setPending(payload);
    const envelope = await BotHost.call({method:'submit', params:{botId: payload.botId, requestId: payload.requestId, text: payload.text}});
    setReceipt(envelope.result as HostSubmission);
    setPending(undefined);
    setDraft('');
  });
  const retryPending = () => action.run(async () => {
    if (!pending || pending.kind !== 'text') return;
    const envelope = await BotHost.call({method:'submit', params:{botId: pending.botId, requestId: pending.requestId, text: pending.text}});
    setReceipt(envelope.result as HostSubmission);
    setPending(undefined);
    setDraft('');
  });
  const fetchSubmission = () => action.run(async () => {
    if (!pending || pending.kind !== 'text') return;
    const envelope = await BotHost.call({method:'getSubmission', params:{botId: pending.botId, requestId: pending.requestId}});
    setReceipt(envelope.result as HostSubmission);
    setPending(undefined);
  });
  const findCreate = () => action.run(async () => {
    if (!pending || pending.kind !== 'create') return;
    const envelope = await BotHost.call({method:'findByRequest', params:{requestId: pending.requestId}});
    setSelected(envelope.result as HostBot);
    setPending(undefined);
  });
  const abortAgent = () => action.run(async () => {
    if (!selected) return;
    await BotHost.call({method:'abort', params:{botId: selected.botId}});
  });
  const observeSelected = () => action.run(async () => {
    if (!selected || observeIdRef.current) return;
    await listenersReady.current;
    if (observeIdRef.current) return;
    const observationId = uuid();
    const targetBotId = selected.botId;
    // Claim ownership before the async call so cleanup can cancel even pre-resolution.
    observeIdRef.current = observationId;
    setObserveId(observationId);
    try {
      await BotHost.observe({observationId, target:{kind:'primary', botId: targetBotId}});
      if (observeIdRef.current !== observationId || selectedRef.current?.botId !== targetBotId) {
        void BotHost.cancelObservation({observationId}).catch(() => {});
      }
    } catch (error) {
      if (observeIdRef.current === observationId) clearObserveId();
      throw error;
    }
  });
  const showHistory = () => action.run(async () => {
    if (!selected) return;
    const envelope = await BotHost.call({method:'history', params:{botId: selected.botId, limit: 20}});
    setHistory(envelope.result as HostHistoryPage);
  });
  const loadSettings = () => action.run(async () => {
    const payload = await BotHost.settingsGet();
    setSettings(payload);
    setSettingsDraft(JSON.stringify(payload.settings, null, 2));
  });
  const saveSettings = () => action.run(async () => {
    if (!settings) return;
    const parsed = JSON.parse(settingsDraft) as HostSettings;
    const payload = await BotHost.settingsSet({input:{expectedRevision: settings.revision, settings: parsed}});
    setSettings(payload);
    setSettingsDraft(JSON.stringify(payload.settings, null, 2));
    await refreshSnapshot(); // reflect restartRequired immediately
  });
  const saveCredentials = () => action.run(async () => {
    const aliases = credDraft.trim() ? JSON.parse(credDraft) as Record<string, unknown> : {};
    await BotHost.saveCredentials({aliases});
    setCredDraft('');
    await refreshSnapshot(); // reflect restartRequired immediately
  });
  const applyVoice = (patch: Partial<HostVoiceSettings>) => action.run(async () => {
    if (!voice) return;
    const next = {...voice, ...patch};
    await BotHost.saveVoiceSettings({settings: next});
    // Read back the public descriptor; never keep optimistic state (no key getter).
    setVoice(await BotHost.voiceSettings());
  });
  const applyRemote = (kind: 'stt'|'tts', next: HostVoiceRemote & {apiKey?: string}) => action.run(async () => {
    if (!voice) return;
    const {apiKey, ...remote} = next;
    const settings: HostVoiceSaveInput = kind === 'stt'
      ? apiKey === undefined ? {...voice, stt: remote} : {...voice, stt: {...remote, apiKey}}
      : apiKey === undefined ? {...voice, tts: remote} : {...voice, tts: {...remote, apiKey}};
    await BotHost.saveVoiceSettings({settings});
    // Read back the public descriptor; hasApiKey comes from the native truth.
    setVoice(await BotHost.voiceSettings());
  });
  const startCapture = () => action.run(async () => {
    if (!selected || pending || captureRef.current) return;
    // Freeze ownership before awaiting listeners so leaving the page during the
    // await cannot start a mic afterwards.
    const cap = {botId: selected.botId, requestId: uuid()};
    captureRef.current = cap;
    setCapture(cap);
    try {
      await listenersReady.current;
      // Re-check after the await: still the same capture, page visible.
      if (captureRef.current !== cap || document.hidden) {
        clearCapture(cap);
        return;
      }
      await BotHost.startVoice(cap);
    } catch (error) {
      clearCapture(cap); // identity guard keeps a newer capture intact
      throw error;
    }
  });
  const finishCapture = () => action.run(async () => { await BotHost.finishVoice(); });
  const cancelCapture = () => action.run(async () => {
    const cap = captureRef.current;
    if (!cap) return;
    await BotHost.cancelVoice();
    clearCapture(cap);
  });
  const lastFrameError = [...frames].reverse().find(frame => frame.error)?.error;
  const openImportedBot = (bot: HostBot) => { void chooseBot(bot); };
  const refreshBotsAfterImport = () => { void listBots(); };
  const applyImportedDraft = (botId: string, text: string) => {
    if (selected?.botId !== botId) return false;
    setDraft(prev => prev ? `${prev}\n\n${text}` : text);
    return true;
  };

  return <main className="page">
    <Header title={t('本机 Host','Local Host')} actions={<button className="button secondary-button" onClick={() => void refreshSnapshot()}>{t('刷新','Refresh')}</button>}/>
    <Section title={t('运行状态','Host status')}>
      {!host && <p className="secondary">{t('正在读取状态…','Loading status…')}</p>}
      {host && <>
        <Row title={t('状态','Status')}><span className={host.phase === 'running' ? 'success' : host.phase === 'failed' ? 'inline-error' : 'secondary'}>{phaseLabel(host.phase, t)}</span></Row>
        <Row title={t('设备 ID','Device ID')} detail={host.deviceId ?? '—'}/>
        {host.restartRequired && <Row title={t('重启后生效','Restart required')}><span className="secondary">{t('配置变更将在下次重启 Host 后生效','Changes apply on the next Host restart')}</span></Row>}
        {host.phase === 'failed' && host.errorCode && <Row title={t('错误','Error')} detail={host.errorCode}/>}
        <div className="action-row">
          {(host.phase === 'stopped' || host.phase === 'failed') && <button className="button" disabled={action.busy || lifecycle?.target === 'running'} onClick={startHost}>{t('启动 Host','Start Host')}</button>}
          {host.phase !== 'stopped' && host.phase !== 'failed' && <button className="button secondary-button" disabled={action.busy || lifecycle?.target === 'stopped'} onClick={stopHost}>{t('停止 Host','Stop Host')}</button>}
        </div>
        {lifecycleNotice && <p className="secondary" role="status">{lifecycleNotice}</p>}
      </>}
    </Section>
    <Section title={t('Bot','Bots')}>
      {host?.phase === 'running'
        ? <>
            <Row title={t('列出 Bot','List bots')} onClick={listBots}/>
            {bots?.map(bot => <Row key={bot.botId} title={bot.role} detail={`${bot.botId} · ${bot.cwd}${bot.modelRef ? ` · ${bot.modelRef}` : ''}`} onClick={() => chooseBot(bot)}/>)}
            {pending?.kind === 'create' && <div className="form"><p className="secondary" role="status">{t('创建未确认：','Unconfirmed create: ')}<code>{pending.requestId}</code> · {pending.role} · {pending.cwd}</p><div className="action-row"><button type="button" className="button secondary-button" onClick={findCreate}>{t('按请求查找','Find by request')}</button></div></div>}
            <form className="form" onSubmit={e => { e.preventDefault(); void createBot(); }}>
              <label>{t('角色','Role')}<input required aria-label={t('角色','Role')} value={role} disabled={pending?.kind === 'create'} onChange={e => setRole(e.target.value)}/></label>
              <label>{t('工作目录','Working directory')}<input required aria-label={t('工作目录','Working directory')} value={cwd} disabled={pending?.kind === 'create'} placeholder={host.workspace ?? ''} onChange={e => setCwd(e.target.value)}/></label>
              <label>{t('模型引用（可选）','Model ref (optional)')}<input aria-label={t('模型引用（可选）','Model ref (optional)')} value={modelRef} disabled={pending?.kind === 'create'} onChange={e => setModelRef(e.target.value)}/></label>
              <p className="secondary">{t('请求 ID：','Request ID: ')}<code>{createReqId}</code></p>
              <button className="button" disabled={action.busy || !!pending || !!capture}>{t('创建 Bot','Create bot')}</button>
            </form>
          </>
        : <p className="secondary">{t('Host 运行后可用。','Available while the Host is running.')}</p>}
    </Section>
    <HostLegacyImport phase={host?.phase ?? 'stopped'} workspace={host?.workspace} locked={!!pending || !!capture} activeBotId={selected?.botId} onOpenBot={openImportedBot} onRefreshBots={refreshBotsAfterImport} onApplyDraft={applyImportedDraft}/>
    {pending && <Section title={t('待确认请求','Pending requests')}>
      {pending.kind === 'text' && <>
        <p className="secondary" role="status">{t('冻结的请求（目标与内容已锁定）：','Frozen request (target and content locked): ')}<br/><code>{pending.botId}</code> · <code>{pending.requestId}</code><br/>{pending.text}</p>
        <div className="action-row">
          <button className="button secondary-button" onClick={fetchSubmission}>{t('查询提交','Get submission')}</button>
          <button className="button secondary-button" onClick={retryPending}>{t('重试原请求','Retry original request')}</button>
        </div>
      </>}
    </Section>}
    {selected && <Section title={t('主会话','Primary chat')}>
      <Row title={selected.role} detail={`${selected.botId} · ${selected.cwd}${selected.modelRef ? ` · ${selected.modelRef}` : ''}`}/>
      <form className="form" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label>{t('消息','Message')}<textarea aria-label={t('消息','Message')} rows={3} value={draft} onChange={e => setDraft(e.target.value)}/></label>
        <div className="action-row">
          <button className="button" disabled={action.busy || !draft.trim() || !!pending || !!capture || host?.phase !== 'running'}>{t('发送','Send')}</button>
          <button type="button" className="button secondary-button" onClick={abortAgent} disabled={host?.phase !== 'running'}>{t('中止当前 Agent','Abort current agent')}</button>
          <button type="button" className="button secondary-button" onClick={observeSelected} disabled={!!observeId || host?.phase !== 'running'}>{t('观察','Observe')}</button>
          <button type="button" className="button secondary-button" onClick={() => { cancelObserve(); setLive(undefined); }} disabled={!observeId}>{t('取消观察','Cancel observation')}</button>
          <button type="button" className="button secondary-button" onClick={showHistory}>{t('历史','History')}</button>
        </div>
      </form>
      {receipt && <Row title={t('提交回执','Receipt')} detail={receiptDetail(receipt)}/>}
      {lastFrameError && <Row title={t('观察错误','Observation error')} detail={`${lastFrameError.code} · ${lastFrameError.outcome} · ${lastFrameError.message}`}/>}
      {live && <Row title={t('实时画面','Live')} detail={liveSummary(live)}/>}
      {history && <>
        <p className="secondary">{t('历史条目数：','History entries: ')}{history.items.length}</p>
        {history.items.map((item, index) => <p key={index} className="secondary">{historyEntry(item)}</p>)}
      </>}
    </Section>}
    <Section title={t('配置','Configuration')}>
      <Row title={t('读取配置','Read configuration')} detail={settings ? `${t('修订号','Revision')} ${settings.revision}${settings.activeRevision !== undefined ? ` · active ${settings.activeRevision}` : ''}` : undefined} onClick={loadSettings}/>
      {settings && <>
        <form className="form" onSubmit={e => { e.preventDefault(); void saveSettings(); }}>
          <label>{t('运行时/中继设置 JSON（不含密钥值）','Runtime/relay settings JSON (no secret values)')}<textarea rows={8} aria-label={t('运行时/中继设置 JSON','Runtime/relay settings JSON')} value={settingsDraft} onChange={e => setSettingsDraft(e.target.value)} spellCheck={false}/></label>
          <button className="button" disabled={action.busy}>{t('保存（CAS）','Save (CAS)')}</button>
        </form>
        <form className="form" onSubmit={e => { e.preventDefault(); void saveCredentials(); }}>
          <label>{t('别名凭据映射（仅写入，遮盖显示）','Alias credential map (write-only, masked)')}<input type="password" autoComplete="new-password" aria-label={t('别名凭据映射','Alias credential map')} placeholder='{"OPENAI_API_KEY": "sk-…"}' value={credDraft} onChange={e => setCredDraft(e.target.value)}/></label>
          <p className="secondary">{t('保存将整体替换现有别名映射；留空会清空。省略的别名会被移除。','Saving replaces the entire alias map; leave blank to clear it. Omitted aliases are removed.')}</p>
          <button className="button" disabled={action.busy}>{t('保存凭据','Save credentials')}</button>
        </form>
      </>}
    </Section>
    <Section title={t('语音','Host voice')}>
      {!voice && <Row title={t('读取语音设置','Read voice settings')} onClick={() => action.run(async () => setVoice(await BotHost.voiceSettings()))}/>}
      {voice && <>
        <Row title={t('识别引擎','Recognition engine')}><select aria-label={t('识别引擎','Recognition engine')} value={voice.sttEngine} onChange={e => applyVoice({sttEngine: e.target.value as HostVoiceSettings['sttEngine']})}><option value="system">{t('系统内置','Built-in')}</option><option value="remote">{t('远程模型','Remote model')}</option></select></Row>
        {voice.sttEngine === 'remote' && <Row title={t('远程识别模型','Remote recognition model')} detail={remoteDetail(voice.stt, t)} onClick={() => setRemoteKind('stt')}/>}
        <Row title={t('朗读引擎','Speech engine')}><select aria-label={t('朗读引擎','Speech engine')} value={voice.ttsEngine} onChange={e => applyVoice({ttsEngine: e.target.value as HostVoiceSettings['ttsEngine']})}><option value="system">{t('系统内置','Built-in')}</option><option value="remote">{t('远程模型','Remote model')}</option></select></Row>
        {voice.ttsEngine === 'remote' && <Row title={t('远程朗读模型','Remote speech model')} detail={remoteDetail(voice.tts, t)} onClick={() => setRemoteKind('tts')}/>}
        <Row title={t('语速','Speech rate')}><select aria-label={t('语速','Speech rate')} value={String(voice.speechRate)} onChange={e => applyVoice({speechRate: Number(e.target.value)})}>{rates.map(rate => <option key={rate} value={String(rate)}>{rate}×</option>)}</select></Row>
        <Row title={t('识别与朗读语言','Recognition & speech language')}><input aria-label={t('识别与朗读语言','Recognition & speech language')} placeholder="zh-CN" defaultValue={voice.language} onBlur={e => applyVoice({language: e.target.value})}/></Row>
        <div className="action-row">
          <button className="button" onClick={startCapture} disabled={action.busy || !!capture || !selected || !!pending}>{t('开始录音','Start mic')}</button>
          <button className="button secondary-button" onClick={finishCapture} disabled={action.busy || !capture}>{t('完成','Finish')}</button>
          <button className="button secondary-button" onClick={cancelCapture} disabled={action.busy || !capture}>{t('取消','Cancel')}</button>
        </div>
        {capture && <p className="secondary" role="status">{t('录制中（完成后由原生提交一次）：','Capturing (native submits once on finish): ')}<code>{capture.requestId}</code></p>}
        {voiceEvents.map((event, index) => <p key={index} className="secondary">{voiceEventText(event, t)}</p>)}
      </>}
    </Section>
    <ErrorNotice error={action.error || snapshotError || storageNotice}/>
    {remoteKind && voice && <RemoteVoiceForm kind={remoteKind} remote={remoteKind === 'stt' ? voice.stt : voice.tts} close={() => setRemoteKind(undefined)} save={next => applyRemote(remoteKind, next)}/>}
  </main>;
}

function RemoteVoiceForm({kind, remote, close, save}: {kind: 'stt'|'tts'; remote: HostVoiceRemote; close(): void; save(next: HostVoiceRemote & {apiKey?: string}): Promise<void> | undefined}) {
  const t = useText(); const action = useAction();
  const [url, setUrl] = useState(remote.baseUrl);
  const [model, setModel] = useState(remote.model);
  const [voice, setVoice] = useState(remote.voice);
  const [key, setKey] = useState('');
  const doSave = (extra: {apiKey?: string}) => action.run(async () => {
    await save({baseUrl: url, model, voice, configured: true, ...extra});
    close();
  });
  return <Dialog open title={kind === 'tts' ? t('远程朗读模型','Remote speech model') : t('远程识别模型','Remote recognition model')} onOpenChange={value => !value && close()}>
    <form className="form" onSubmit={e => { e.preventDefault(); void doSave(key.trim() ? {apiKey: key} : {}); }}>
      <p className="secondary">{t('地址须为 https；API Key 仅保存在本机，不会显示或导出。','Base URL must be https; API keys stay on this device and are never shown or exported.')}</p>
      <label>{t('接口地址','Base URL')}<input inputMode="url" placeholder="https://api.openai.com/v1" value={url} onChange={e => setUrl(e.target.value)}/></label>
      <label>API Key<input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder={remote.hasApiKey ? t('已保存，留空保持不变','Saved; leave blank to keep') : t('可选','Optional')}/></label>
      <label>{t('模型','Model')}<input value={model} onChange={e => setModel(e.target.value)}/></label>
      <label>{t('音色（voice）','Voice')}<input value={voice} onChange={e => setVoice(e.target.value)}/></label>
      <ErrorNotice error={action.error}/>
      <div className="dialog-actions"><button type="button" className="button secondary-button" disabled={action.busy || !remote.hasApiKey} onClick={() => void doSave({apiKey: ''})}>{t('清除 API Key','Remove API key')}</button><button className="button" disabled={action.busy}>{t('保存','Save')}</button></div>
    </form>
  </Dialog>;
}
