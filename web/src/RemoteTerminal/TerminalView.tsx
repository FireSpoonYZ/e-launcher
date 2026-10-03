import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, CornerDownLeft, Delete, Ellipsis, Keyboard } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { createRecovery, recoveryErrorCode, recoveryStops } from './recovery';
import { ErrorNotice, useText } from '../ui';
import { RemoteTerminal, request, type Session, type Snapshot, type TerminalEvent } from './native';
import { activateOrcaTerminalUnicodeProvider } from './orca/terminal-unicode-provider';
import { readTerminalMouseEncoding } from './orca/terminal-mouse-encoding';
import { parseTerminalKittyKeyboardFlags } from './orca/terminal-kitty-keyboard-flags';
import { TERMINAL_ACCESSORY_KEYS, type TerminalShortcutModifier, type TerminalShortcutBinding } from './orca/terminal-accessory-keys';
import { createTerminalAccessoryRepeatController } from './orca/terminal-accessory-repeat';
import { bindTerminalTextFieldSubmit } from './orca/terminal-text-field-submit-binding.web';
import { isTerminalGestureInput } from './orca/terminal-gesture-input';
import { routeScrollLines, buildMouseClickInput, type GestureScope } from './gestures';
import { encodeKey, encodeText, encodeModifiedText, encodePaste, hardwareBinding, hardwareKeyDown, isTerminalSendWithinLimit, terminalInputByteLength, LiveInput, type LiveInputDelivery, type HardwareBinding, type InputModes } from './input';
import { Presets } from './PresetPanel';
import { AccessoryButton } from './AccessoryButton';
import { presetInput } from './presets';
import { SessionTabs } from './SessionTabs';
import { terminalDraftNeedsGuard } from './session-navigation';

type KittyCore = { _core?: { coreService?: { kittyKeyboard?: { flags: number } } } };
export function TerminalPage() {
  const {hostId = '', sessionId = ''} = useParams();
  return <TerminalView key={hostId + '/' + sessionId} hostId={hostId} sessionId={sessionId}/>;
}
function TerminalView({hostId, sessionId}: {hostId: string; sessionId: string}) {
  const t = useText(); const nav = useNavigate();
  const element = useRef<HTMLDivElement>(null); const field = useRef<HTMLTextAreaElement>(null);
  const terminal = useRef<Terminal | null>(null); const fitAddon = useRef<FitAddon | null>(null);
  const [session, setSession] = useState<Session>(); const [connected, setConnected] = useState(false);
  const [error, setError] = useState(''); const [owner, setOwner] = useState(false);
  const [modifiers, setModifiers] = useState<TerminalShortcutModifier[]>([]);
  const [fontSize, setFontSize] = useState(14); const [selecting, setSelecting] = useState(false);
  const [selectionText, setSelectionText] = useState<string>();
  const [menu, setMenu] = useState(false); const [recovering, setRecovering] = useState(true);
  const [inputBusy, setInputBusy] = useState(false);
  const [hostName, setHostName] = useState(''); const [missing, setMissing] = useState(false);
  const [inputError, setInputError] = useState('');
  const live = useRef(new LiveInput()); const alive = useRef(false);
  const canSend = useRef(false); const clientId = useRef(''); const sessionState = useRef<Session | undefined>(undefined);
  const reconnect = useRef<() => Promise<void>>(async () => {});
  const repeat = useRef(createTerminalAccessoryRepeatController<TerminalShortcutBinding>());
  const sendChain = useRef(Promise.resolve(true));
  const inputEpoch = useRef(0); const queuedInputBytes = useRef(0);
  const modifierState = useRef(modifiers); modifierState.current = modifiers;
  const replaying = useRef(false);
  const replayModes = useRef<InputModes>({applicationCursor:false,bracketedPaste:false});
  const rejectedDraft = useRef(false);
  const boundaryPending = useRef(false);
  const pendingDeliveries = useRef(new Map<() => void, number>());
  const retireStaleDeliveries = () => {
    const oldestEpoch = pendingDeliveries.current.values().next().value;
    if (oldestEpoch === undefined || oldestEpoch === inputEpoch.current) return;
    // Only callbacks still waiting for dispatch are safe to cancel. Retire them
    // before a recovered epoch computes any delta against the old mirror.
    for (const [cancel, epoch] of pendingDeliveries.current) {
      if (epoch !== inputEpoch.current) cancel();
    }
  };
  const invalidateInput = () => { inputEpoch.current++; retireStaleDeliveries(); };
  const resetField = () => {
    retireStaleDeliveries();
    // Lifecycle resets may retire echoed text, never unsent or ambiguous drafts.
    if (rejectedDraft.current || queuedInputBytes.current || live.current.uncertain || live.current.composing || (field.current && field.current.value !== live.current.sentText)) return;
    live.current.reset(); if (field.current) field.current.value = '';
  };
  const inputHeld = () => setInputError(t('输入尚未发送，草稿已保留；恢复控制后继续编辑或按 Enter 重试。','Input was not sent. Draft kept; resume control and edit or press Enter to retry.'));
  const inputUncertain = () => setInputError(t('无法确认输入是否已送达。草稿已保留但不会重发；请检查终端后清空输入框，再继续输入。','Input delivery is unknown. Draft kept but will not be resent; check the terminal, then clear the input field before continuing.'));
  const modes = (): InputModes => {
    if (replaying.current) return replayModes.current;
    const term = terminal.current;
    return { applicationCursor: term?.modes.applicationCursorKeysMode ?? false,
      bracketedPaste: term?.modes.bracketedPasteMode ?? false,
      kittyFlags: (term as KittyCore | null)?._core?.coreService?.kittyKeyboard?.flags };
  };
  const acceptInput = (data: string): boolean => {
    if (!isTerminalSendWithinLimit(data)) { setInputError(t('输入超过 64 KiB，请缩短后重试','Input exceeds 64 KiB; shorten it and retry')); return false; }
    if (queuedInputBytes.current + terminalInputByteLength(data) > 256 * 1024) { setInputError(t('输入队列已满，请稍后重试','Input queue full; retry shortly')); return false; }
    return true;
  };
  // Admission is synchronous; completion is not. Mirror ownership begins only
  // after this queue accepts the exact encoded bytes for the current input epoch.
  const admitSend = (data: string, delivery?: LiveInputDelivery): Promise<boolean> | null => {
    if (!data || !canSend.current || !alive.current) { if (data) inputHeld(); return null; }
    if (!acceptInput(data)) return null;
    const byteLength = terminalInputByteLength(data);
    queuedInputBytes.current += byteLength;
    const epoch = inputEpoch.current, mirror = live.current;
    let retired = false;
    const cancel = () => {
      if (retired) return;
      retired = true; pendingDeliveries.current.delete(cancel); delivery?.cancelled();
    };
    if (delivery) pendingDeliveries.current.set(cancel, epoch);
    sendChain.current = sendChain.current.then(async () => {
      if (retired) return false;
      if (!canSend.current || !alive.current || epoch !== inputEpoch.current) {
        if (epoch === inputEpoch.current) invalidateInput();
        cancel(); return false;
      }
      // From this point delivery may be unknown: lifecycle retirement must not
      // treat an in-flight request as definitely undispatched.
      pendingDeliveries.current.delete(cancel);
      try { await request(hostId,'terminal.send',{sessionId,data}); return true; }
      catch {
        canSend.current = false; setOwner(false);
        if (delivery) delivery.uncertain(); else mirror.uncertain = true;
        invalidateInput(); inputUncertain(); return false;
      }
    }).finally(() => { queuedInputBytes.current -= byteLength; });
    return sendChain.current;
  };
  const send = (data: string): Promise<boolean> => admitSend(data) ?? Promise.resolve(false);
  const changeText = () => {
    retireStaleDeliveries();
    if (!field.current) return true;
    const mirror = live.current;
    const sticky = modifierState.current;
    const text = mirror.change(field.current.value, (payload, delivery) => {
      const encoded=encodeModifiedText(payload,sticky,modes());
      if(encoded === null) { setInputError(t('当前修饰键无法编码部分输入，草稿已保留。请关闭修饰键或启用 Kitty 键盘协议后重试。','Some input cannot be encoded with these modifiers. Draft kept; turn off the modifiers or enable Kitty keyboard support and retry.')); return false; }
      return admitSend(encoded, {
        cancelled: () => { delivery.cancelled(); if (live.current === mirror) { rejectedDraft.current = true; if (mirror.uncertain) inputUncertain(); else inputHeld(); } },
        uncertain: () => { delivery.uncertain(); if (live.current === mirror) rejectedDraft.current = true; },
      }) !== null;
    });
    rejectedDraft.current = text === null;
    if (mirror.uncertain) inputUncertain();
    else if (text !== null) setInputError('');
    return text !== null;
  };
  const sendAfterText = (data: string): Promise<boolean> => {
    retireStaleDeliveries();
    if (live.current.composing || !acceptInput(data)) return Promise.resolve(false);
    // Empty-field controls need no mirror reset and remain freely repeatable.
    if (!field.current?.value && !live.current.sentText) return send(data);
    // Do not overwrite ownership of a draft still attached to an unsettled
    // Enter/paste/preset. Typing and ordinary accessory keys keep their queue.
    if (boundaryPending.current) { setInputError(t('上一条提交尚未完成，本次提交未发送，草稿已保留；完成后请重试。','Previous submission is pending. This submission was not sent; draft kept. Retry after it completes.')); return Promise.resolve(false); }
    if (!changeText()) return Promise.resolve(false);
    const previous = live.current, draft = field.current?.value || '';
    const next = new LiveInput();
    const restore = (uncertain: boolean) => {
      if (uncertain) previous.uncertain = true;
      if (live.current !== next) return;
      previous.composing = next.composing; live.current = previous;
      if (field.current) field.current.value = draft + field.current.value;
      rejectedDraft.current = true;
      if (uncertain || previous.uncertain) inputUncertain(); else inputHeld();
    };
    const result = admitSend(data, {cancelled: () => restore(false), uncertain: () => restore(true)});
    if (!result) return Promise.resolve(false);
    boundaryPending.current = true; setInputBusy(true);
    live.current = next; rejectedDraft.current = false;
    if (field.current) field.current.value = '';
    return result.finally(() => { boundaryPending.current = false; setInputBusy(false); });
  };
  const special = (binding: HardwareBinding, eventType = 1) => {
    retireStaleDeliveries();
    if (!live.current.composing && binding.key === 'backspace' && !binding.modifiers.length && !binding.metaKey && field.current?.value) {
      const input = field.current;
      const end = input.selectionEnd ?? input.value.length;
      let start = input.selectionStart ?? end;
      if (start === end && start > 0) start -= Array.from(input.value.slice(0, start)).at(-1)!.length;
      input.setRangeText('', start, end, 'end');
      if (!changeText()) return Promise.resolve(false);
      return sendChain.current;
    }
    const data = encodeKey(binding, modes(), eventType);
    if (!data && eventType !== 3) { setInputError(t('当前终端协议无法表示此组合键；请启用 Kitty 键盘协议或选择其他组合。','The current terminal protocol cannot encode this combination. Enable Kitty keyboard support or choose another shortcut.')); return Promise.resolve(false); }
    if (binding.key === 'enter') return sendAfterText(data);
    if (live.current.composing || !acceptInput(data) || !changeText()) return Promise.resolve(false);
    return send(data);
  };
  const updateViewport = async () => {
    if (!canSend.current) return;
    const dimensions = fitAddon.current?.proposeDimensions();
    if (dimensions && dimensions.cols >= 2 && dimensions.rows >= 1 && (dimensions.cols !== terminal.current?.cols || dimensions.rows !== terminal.current?.rows)) {
      await request(hostId,'terminal.updateViewport',{sessionId,...dimensions});
    }
  };
  useEffect(() => {
    const input = field.current;
    const unbind = bindTerminalTextFieldSubmit(input, () => {
      // beforeinput line-break is a submit, not an IME candidate keydown.
      live.current.composing = false;
      void special({key:'enter',modifiers:modifierState.current});
    });
    const eraseEmptyField = (event: Event) => {
      const e = event as InputEvent;
      if (e.inputType === 'deleteContentBackward' && !live.current.composing && !input?.value) {
        e.preventDefault(); void special({key:'backspace',modifiers:modifierState.current});
      }
    };
    input?.addEventListener('beforeinput',eraseEmptyField);
    return () => { unbind(); input?.removeEventListener('beforeinput',eraseEmptyField); };
  }, []);
  useEffect(() => {
    alive.current = true;
    let disposed = false, initialized = false, reconnecting = false, seq = -1;
    let pending: TerminalEvent[] = [], pendingSize = 0, writeBytes = 0;
    let outputChain = Promise.resolve();
    let generation = 0;
    const subscriptionId = crypto.randomUUID();
    void RemoteTerminal.listHosts().then(({hosts}) => { if (!disposed) setHostName(hosts.find(h => h.id === hostId)?.name || ''); }).catch(() => {});
    let listener: Awaited<ReturnType<typeof RemoteTerminal.addListener>> | undefined;
    let appListener: Awaited<ReturnType<typeof CapacitorApp.addListener>> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const term = new Terminal({ allowProposedApi:true, disableStdin:true, scrollback:5000, fontSize:14, cursorBlink:true,
      vtExtensions:{kittyKeyboard:true}, theme:{background:'#111318',foreground:'#e6e9ef'} });
    terminal.current = term;
    const fit = new FitAddon(); fitAddon.current = fit; term.loadAddon(fit); term.loadAddon(new Unicode11Addon());
    activateOrcaTerminalUnicodeProvider(term);
    term.open(element.current!);
    // No onData/onBinary bridge: parser DA/CPR replies and xterm's hidden textarea can never reach the PTY.
    const applyTheme = () => {
      const style = getComputedStyle(element.current!);
      term.options.theme = {background:style.getPropertyValue('--bg').trim() || '#111318',foreground:style.getPropertyValue('--text').trim() || '#e6e9ef'};
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme); themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const systemTheme = matchMedia('(prefers-color-scheme: dark)'); systemTheme.addEventListener('change',applyTheme);
    const write = (data: string) => new Promise<void>(resolve => term.write(data,resolve));
    const refreshOwner = () => {
      const next = initialized && sessionState.current?.status === 'running' && sessionState.current.ownerClientId === clientId.current;
      canSend.current = next; setOwner(next);
      if (!next) { invalidateInput(); repeat.current.stop(); resetField(); }
    };
    const snapshot = async (value: Snapshot) => {
      // Resize snapshots must not cancel an active IME composition or discard queued input.
      // Retain the last parsed modes while xterm briefly resets and replays equivalent state.
      replayModes.current = modes(); replaying.current = true;
      term.reset(); term.resize(value.cols,value.rows);
      await write(value.ansi);
      if (disposed) return;
      const flags = parseTerminalKittyKeyboardFlags(value.kittyKeyboardFlags);
      const kitty = (term as KittyCore)._core?.coreService?.kittyKeyboard;
      if (kitty && flags !== undefined) kitty.flags = flags;
      seq = value.seq; replaying.current = false; refreshOwner();
    };
    const fail = (e: unknown) => {
      if (disposed) return;
      initialized = false; generation++; invalidateInput(); pending = []; pendingSize = 0;
      canSend.current = false; setConnected(false); setOwner(false); repeat.current.stop(); resetField(); setError(String(e));
    };
    const receive = async (event: TerminalEvent) => {
      if (disposed) return;
      if (event.event === 'terminal.output') {
        if (event.seq <= seq) return;
        if (event.seq !== seq + 1) throw new Error('Output sequence gap. Reconnect to resynchronize.');
        await write(event.data); seq = event.seq;
      } else if (event.event === 'terminal.snapshot') {
        if (event.snapshot.seq >= seq) await snapshot(event.snapshot);
      } else if (event.event === 'terminal.control' && sessionState.current) {
        sessionState.current = {...sessionState.current,ownerClientId:event.ownerClientId};
        setSession(sessionState.current); refreshOwner();
      } else if (event.event === 'terminal.exit' && sessionState.current) {
        sessionState.current = {...sessionState.current,status:'exited',exitCode:event.exitCode};
        setSession(sessionState.current); refreshOwner();
      }
    };
    const enqueue = (event: TerminalEvent) => {
      const size = event.event === 'terminal.output' ? event.data.length : event.event === 'terminal.snapshot' ? event.snapshot.ansi.length : 1;
      writeBytes += size;
      if (writeBytes > 4 * 1024 * 1024) {
        fail(new Error('Output queue overflow. Reconnect for a fresh snapshot.'));
        void RemoteTerminal.disconnect({hostId}).catch(() => {});
        return;
      }
      const expected = generation;
      outputChain = outputChain.then(async () => { if (expected === generation && initialized) await receive(event); }).catch(e => { if (expected === generation) { fail(e); recovery.invalidate(); void recovery.wake(); } }).finally(() => { writeBytes -= size; });
    };
    const recovery = createRecovery(async current => {
      if (disposed) return;
      reconnecting = true; setRecovering(true); setConnected(false); initialized = false; canSend.current = false; setOwner(false); pending = []; pendingSize = 0; generation++; invalidateInput();
      const attempt = generation;
      const valid = () => current() && !disposed && attempt === generation;
      try {
        const connection = await RemoteTerminal.connect({hostId});
        if (!valid()) return;
        clientId.current = connection.clientId;
        const result = await request<{session:Session;snapshot:Snapshot}>(hostId,'terminal.subscribe',{sessionId,subscriptionId});
        if (!valid()) { if (disposed) void request(hostId,'terminal.unsubscribe',{sessionId,subscriptionId}).catch(() => {}); return; }
        await outputChain;
        if (!valid()) return;
        sessionState.current = result.session; setSession(result.session);
        await snapshot(result.snapshot);
        if (!valid()) return;
        initialized = true; setConnected(true); setRecovering(false); setMissing(false); setError(''); refreshOwner();
        pending.splice(0).forEach(enqueue); pendingSize = 0;
      } finally { reconnecting = false; }
    }, e => {
      fail(e); setRecovering(false);
      const code = recoveryErrorCode(e);
      if (['NOT_FOUND','SESSION_NOT_FOUND'].includes(code)) { setMissing(true); setError(t('会话已不存在，请返回会话列表。','Session no longer exists. Return to the session list.')); }
      else if (['UNAUTHORIZED','PIN_MISMATCH','CERTIFICATE_ERROR','CERTIFICATE_INVALID'].includes(code)) setError(t('无法验证主机身份或配对已失效。请在桌面检查配对和证书。','Host identity or pairing could not be verified. Check pairing and certificate on the desktop.'));
      else setError(t('主机暂时不可用，正在重试。终端内容已保留。','Host unavailable; retrying. Terminal contents are preserved.'));
    });
    reconnect.current = () => recovery.retry();
    void (async () => {
      listener = await RemoteTerminal.addListener('terminalEvent', event => {
        if (disposed || event.hostId !== hostId) return;
        if (event.event === 'connection') {
          if (event.state === 'disconnected' && recoveryStops(event)) { recovery.stop(event); return; }
          if (event.state === 'disconnected' && recovery.blocked) return;
          if (event.state === 'disconnected') { fail(event.message || t('连接中断','Connection interrupted')); recovery.invalidate(); void recovery.wake(); }
          else if (!initialized && !reconnecting) void recovery.wake();
          return;
        }
        if (!('sessionId' in event) || event.sessionId !== sessionId) return;
        if (!initialized) {
          if (!reconnecting) return;
          pendingSize += event.event === 'terminal.output' ? event.data.length : event.event === 'terminal.snapshot' ? event.snapshot.ansi.length : 1;
          if (pendingSize > 4 * 1024 * 1024 || pending.length > 4096) { fail('Snapshot queue overflow'); void RemoteTerminal.disconnect({hostId}).catch(() => {}); return; }
          pending.push(event);
        } else enqueue(event);
      });
      if (disposed) { await listener.remove(); return; }
      appListener = await CapacitorApp.addListener('appStateChange', state => {
        if (state.isActive) void recovery.resume();
        else { recovery.pause(); generation++; initialized = false; setConnected(false); invalidateInput(); canSend.current = false; setOwner(false); repeat.current.stop(); resetField(); }
      });
      if (disposed) { await appListener.remove(); return; }
      await recovery.wake();
    })().catch(fail);
    const resize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { void updateViewport().catch(e => setError(String(e))); }, 150); };
    const observer = new ResizeObserver(resize); observer.observe(element.current!);
    window.visualViewport?.addEventListener('resize',resize);
    return () => {
      recovery.dispose(); disposed = true; alive.current = false; generation++; invalidateInput(); canSend.current = false; repeat.current.stop();
      clearTimeout(resizeTimer); observer.disconnect(); themeObserver.disconnect(); systemTheme.removeEventListener('change',applyTheme);
      window.visualViewport?.removeEventListener('resize',resize);
      void listener?.remove(); void appListener?.remove();
      void request(hostId,'terminal.unsubscribe',{sessionId,subscriptionId}).catch(() => {});
      // Neither back nor background closes the shell.
      term.dispose(); terminal.current = null; fitAddon.current = null;
    };
  }, [hostId, sessionId]);
  useEffect(() => { if (terminal.current) terminal.current.options.fontSize = fontSize; void updateViewport().catch(e => setError(String(e))); }, [fontSize,owner]);
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); setError(''); } catch (e) { setError(String(e)); } };
  const pressed = useRef(new Map<string, HardwareBinding>());
  const scope = (): GestureScope | null => {
    const term = terminal.current; const screen = element.current?.querySelector('.xterm-screen');
    if (!term || !screen) return null;
    const encoding = readTerminalMouseEncoding(term);
    return {term,rect:screen.getBoundingClientRect(),mouseEncodingKnown:true,sgrMouseMode:encoding === 'sgr',sgrMousePixelsMode:encoding === 'sgr-pixels',
      send: bytes => { if (isTerminalGestureInput(bytes)) void send(bytes); }};
  };
  const touch = useRef<{x:number;y:number;startX:number;startY:number;moved:boolean;at:number} | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const resize = () => setKeyboardOpen(window.screen.height - (window.visualViewport?.height ?? window.innerHeight) > 140);
    resize(); window.visualViewport?.addEventListener('resize',resize);
    return () => window.visualViewport?.removeEventListener('resize',resize);
  }, []);
  const [leaveTo, setLeaveTo] = useState<string>();
  const [controlBusy, setControlBusy] = useState(false);
  const controlPending = useRef(false);
  const hasUnsentInput = () => terminalDraftNeedsGuard({composing:live.current.composing, uncertain:live.current.uncertain, rejected:rejectedDraft.current, queuedBytes:queuedInputBytes.current, pending:boundaryPending.current, value:field.current?.value || '', sentText:live.current.sentText});
  const leave = (path: string) => {if (hasUnsentInput()) setLeaveTo(path); else nav(path);};
  useEffect(() => {
    const back = (event: Event) => {if (hasUnsentInput()) {event.preventDefault(); setLeaveTo('/terminals');}};
    window.addEventListener('app-back',back);
    return () => window.removeEventListener('app-back',back);
  }, []);
  const control = async () => {
    if (!connected || controlPending.current || session?.status !== 'running') return;
    controlPending.current = true; setControlBusy(true);
    try {await run(() => request(hostId,owner ? 'terminal.release' : 'terminal.claim',{sessionId}));}
    finally {controlPending.current = false; setControlBusy(false);}
  };
  const keyButton = (k: (typeof TERMINAL_ACCESSORY_KEYS)[number]) => {
    const binding={key:k.id === 'shiftTab' ? 'tab' : k.id,modifiers:k.id === 'shiftTab' ? [...new Set([...modifiers,'shift' as const])] : modifiers};
    const glyph = k.id === 'arrowUp' ? <ArrowUp/> : k.id === 'arrowDown' ? <ArrowDown/> : k.id === 'arrowLeft' ? <ArrowLeft/> : k.id === 'arrowRight' ? <ArrowRight/> : k.id === 'backspace' ? <Delete/> : k.id === 'enter' ? <CornerDownLeft/> : k.label;
    return <AccessoryButton key={k.id} disabled={!owner} label={k.accessibilityLabel || k.label}
      onPress={() => {void special(binding);}}
      onHold={k.repeatable ? () => repeat.current.start(binding, input => special(input)) : undefined}
      onRelease={() => repeat.current.stop()}>{glyph}</AccessoryButton>;
  };
  return <main className="rt-terminal">
    <header className="rt-header">
      <button className="icon-button" aria-label={t('返回会话','Back to sessions')} onClick={() => leave('/terminals')}><ArrowLeft/></button>
      <div className="rt-heading"><strong>{hostName || t('远程终端','Remote terminal')}</strong><small role="status"><i className="rt-status-dot" data-state={recovering ? 'connecting' : connected ? 'connected' : 'offline'}/>{missing ? t('会话已结束','Session ended') : recovering ? t('正在重连…','Reconnecting…') : !connected ? t('离线 · 保留终端内容','Offline · output retained') : session?.status === 'exited' ? t('已退出','Exited') : owner ? t('正在控制','Controlling') : t('只读','Read only')}</small></div>
      <button className="icon-button" aria-label={t('终端选项','Terminal options')} onClick={() => setMenu(true)}><Ellipsis/></button>
    </header>
    <SessionTabs hostId={hostId} sessionId={sessionId} session={session} connected={connected} navigate={leave}/>
    <ErrorNotice error={inputError || error}/>
    <Dialog sheet className="rt-sheet" open={menu} onOpenChange={setMenu} title={t('终端选项','Terminal options')}>
      <div className="rt-menu">
        {owner && <button disabled={controlBusy} onClick={() => {setMenu(false); void control();}}>{t('释放控制','Release control')}</button>}
        <button onClick={() => { setMenu(false); void reconnect.current(); }}>{connected ? t('重新同步','Resync') : t('重新连接','Reconnect')}</button>
        <button disabled={!owner} onClick={() => { setMenu(false); void run(updateViewport); }}>{t('适应屏幕','Fit to screen')}</button>
        <div className="rt-size"><span>{t('文字大小','Text size')} · {fontSize}</span><button aria-label={t('缩小字体','Smaller text')} onClick={() => setFontSize(v => Math.max(8,v-2))}>A−</button><button aria-label={t('放大字体','Larger text')} onClick={() => setFontSize(v => Math.min(30,v+2))}>A+</button></div>
        <button aria-pressed={selecting} onClick={() => { setSelecting(!selecting); field.current?.blur(); setMenu(false); }}>{selecting ? t('结束选择','Finish selecting') : t('选择终端文本','Select terminal text')}</button>
        <button onClick={() => { const term=terminal.current; if (term) setSelectionText(term.getSelection() || Array.from({length:term.rows},(_,i) => term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true) ?? '').join('\n')); setMenu(false); }}>{t('复制终端文本','Copy terminal text')}</button>
        <p className="secondary">{t('离开页面不会结束电脑上的 Shell。终端目前仅支持文本。','Leaving keeps your desktop shell running. Text terminals are supported.')}</p>
      </div>
    </Dialog>
    <Dialog sheet className="rt-sheet" open={selectionText !== undefined} onOpenChange={open => { if (!open) setSelectionText(undefined); }} title={t('复制文本','Copy text')}>
      <div className="rt-copy"><textarea readOnly aria-label={t('可复制的终端文本','Terminal text to copy')} value={selectionText || ''} onFocus={e => e.currentTarget.select()}/><button className="rt-primary" onClick={() => void run(() => navigator.clipboard.writeText(selectionText || ''))}>{t('复制文本','Copy text')}</button></div>
    </Dialog>
    <div ref={element} className={'rt-screen' + (selecting ? ' rt-select' : '')} onPointerDown={e => {
      if (selecting || e.pointerType === 'mouse') return;
      e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
      touch.current={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,at:Date.now()};
    }} onPointerMove={e => {
      const point=touch.current; if (!point || selecting) return;
      const delta=point.y-e.clientY; if (Math.abs(delta)<18) return;
      point.moved=true; point.y=e.clientY;
      const current=scope(); if(current) routeScrollLines(current,Math.trunc(delta/18),e.clientX,e.clientY);
    }} onPointerUp={e => {
      const point=touch.current; touch.current=null;
      if (!point || point.moved || selecting || Date.now()-point.at>500) return;
      const current=scope(); if(current) { const bytes=buildMouseClickInput(current,e.clientX,e.clientY); if(bytes) current.send(bytes); else if(owner) field.current?.focus(); }
    }} onPointerCancel={() => {touch.current=null;}}/>
    <footer className="rt-dock" data-keyboard-open={keyboardOpen}>
    <Presets disabled={!owner || live.current.composing} activeModifiers={modifiers}
      send={preset => {if (preset.kind === 'chord') void special(preset.chord); else void sendAfterText(presetInput(preset,modes()));}}
      accessoryKeys={<>
        {(['ctrl','alt','shift'] as TerminalShortcutModifier[]).map(m => <AccessoryButton key={m} disabled={!owner} label={m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : 'Shift'} pressed={modifiers.includes(m)} onPress={() => setModifiers(v => v.includes(m) ? v.filter(x => x !== m) : [...v,m])}>{m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : 'Shift'}</AccessoryButton>)}
        {['escape','tab','arrowUp','arrowDown','arrowLeft','arrowRight','shiftTab','backspace','enter'].map(id => TERMINAL_ACCESSORY_KEYS.find(k => k.id === id)!).map(keyButton)}
      </>}/>
    <div className="rt-live-row"><textarea ref={field} className="rt-live-input" disabled={!owner} rows={1} aria-busy={inputBusy}
      aria-label={t('实时终端输入（支持中文输入法）','Live terminal input (IME supported)')} placeholder={inputBusy ? t('正在发送…','Sending…') : !owner ? t('接管后即可输入','Take control to type') : t('实时输入…','Type live…')}
      autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send"
      onCompositionStart={() => { live.current.composing=true; }}
      onCompositionEnd={() => { live.current.composing=false; changeText(); }}
      onInput={changeText}
      onPaste={e => { if(live.current.composing) return; e.preventDefault(); void sendAfterText(encodePaste(e.clipboardData.getData('text'),modes())); }}
      onKeyDown={e => {
        if(live.current.composing) return;
        // Rejected unsent drafts remain locally editable without flushing or remote deletion.
        if (rejectedDraft.current && (Array.from(e.key).length === 1 || ['Backspace','Delete','ArrowLeft','ArrowRight','Home','End'].includes(e.key))) return;
        const input=hardwareKeyDown(e.nativeEvent,modes(),modifiers);
        if(!input) return;
        e.preventDefault(); pressed.current.set(e.code,input.binding); void special(input.binding,input.eventType);
      }}
      onKeyUp={e => { const binding=pressed.current.get(e.code); if(!binding) return; pressed.current.delete(e.code); const release=hardwareBinding(e.nativeEvent); release.modifiers=[...new Set([...release.modifiers,...modifiers])]; void send(encodeKey(release,modes(),3)); }}
      onBlur={() => { repeat.current.stop(); pressed.current.clear(); }}
    />{!owner && session?.status !== 'exited' ? <button className="rt-primary rt-control" disabled={!connected || controlBusy || missing} onClick={() => void control()}>{controlBusy ? t('请稍候…','Wait…') : t('接管输入','Take control')}</button> : <button className="rt-keyboard-toggle" disabled={!owner} onPointerDown={e => e.preventDefault()} onClick={() => { if(document.activeElement === field.current) field.current?.blur(); else field.current?.focus(); }} aria-label={t('显示或隐藏键盘','Show or hide keyboard')}><Keyboard size={20}/></button>}</div>
    </footer>
    <Dialog sheet className="rt-sheet" open={!!leaveTo} onOpenChange={open => {if (!open) setLeaveTo(undefined);}} title={t('保留当前输入？','Keep this input?')}><p>{t('部分输入尚未确认送达。离开将丢弃本机草稿，已送出的输入不会撤回。','Some input has not been confirmed. Leaving discards this local draft; input already sent cannot be recalled.')}</p><div className="rt-dialog-actions"><button className="rt-primary" onClick={() => setLeaveTo(undefined)}>{t('留在会话','Stay here')}</button><button className="rt-danger" onClick={() => {if (leaveTo) nav(leaveTo);}}>{t('丢弃草稿并离开','Discard draft and leave')}</button></div></Dialog>
  </main>;
}
