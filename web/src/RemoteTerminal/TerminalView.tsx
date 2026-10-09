import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as CapacitorApp } from '@capacitor/app';
import { Terminal } from '@xterm/xterm';
import { Capacitor } from '@capacitor/core';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './selection.css';
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, CornerDownLeft, Delete, Ellipsis, Keyboard } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { createRecovery, recoveryErrorCode, recoveryStops } from './recovery';
import { attachTerminalRenderer } from './renderer';
import { ErrorNotice, useText } from '../ui';
import { RemoteTerminal, request, type Session, type Snapshot, type TerminalEvent, type DisplayMode } from './native';
import { activateOrcaTerminalUnicodeProvider } from './orca/terminal-unicode-provider';
import { readTerminalMouseEncoding } from './orca/terminal-mouse-encoding';
import { parseTerminalKittyKeyboardFlags } from './orca/terminal-kitty-keyboard-flags';
import { TERMINAL_ACCESSORY_KEYS, type TerminalShortcutModifier, type TerminalShortcutBinding } from './orca/terminal-accessory-keys';
import { createTerminalAccessoryRepeatController } from './orca/terminal-accessory-repeat';
import { bindTerminalTextFieldSubmit } from './orca/terminal-text-field-submit-binding.web';
import { isTerminalGestureInput } from './orca/terminal-gesture-input';
import { routeScrollLines, buildMouseClickInput, type GestureScope } from './gestures';
import { terminalAccessoryBinding, encodeKey, encodeModifiedText, encodePaste, hardwareBinding, hardwareKeyDown, isTerminalSendWithinLimit, terminalInputByteLength, LiveInput, type LiveInputDelivery, type HardwareBinding, type InputModes } from './input';
import { Presets } from './PresetPanel';
import { AccessoryButton } from './AccessoryButton';
import { presetInput } from './presets';
import { SessionTabs } from './SessionTabs';
import { terminalDraftNeedsGuard } from './session-navigation';
import { DEFAULT_TERMINAL_THEME, MOBILE_TERMINAL_CARET_OPTIONS } from './orca/theme';
import { terminalFontFamily, fontPxForScale } from './orca/text-scaling';
import { TERMINAL_TEXT_SCALES } from './orca/terminal-text-scales';
import { normalizeStatusDotPresentation } from './orca/status-dot';
import { applyGridScale, phoneViewport } from './viewport';
import { attachTerminalSurface } from './surface';
import { readTerminalClipboard, writeTerminalClipboard } from './clipboard';
import { claimTerminalDraft, type TerminalComposerDraft } from './drafts';
import { TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, normalizeTerminalAccessoryLayoutPreference, createTerminalAccessoryLayoutPreference, setTerminalAccessoryBuiltInVisible, reorderTerminalAccessoryBuiltInIds, getVisibleTerminalAccessoryKeys, type TerminalAccessoryLayout } from './orca/terminal-accessory-layout';

type KittyCore = { _core?: { coreService?: { kittyKeyboard?: { flags: number } } } };
export function TerminalPage() {
  const {hostId = '', sessionId = ''} = useParams();
  return <TerminalView key={hostId + '/' + sessionId} hostId={hostId} sessionId={sessionId}/>;
}
function TerminalView({hostId, sessionId}: {hostId: string; sessionId: string}) {
  const t = useText(); const nav = useNavigate();
  const element = useRef<HTMLDivElement>(null); const field = useRef<HTMLTextAreaElement>(null);
  const terminal = useRef<Terminal | null>(null); const viewportFrame = useRef<number | undefined>(undefined);
  const [session, setSession] = useState<Session>(); const [connected, setConnected] = useState(false);
  const [error, setError] = useState(''); const [owner, setOwner] = useState(false);
  const modifiers: TerminalShortcutModifier[] = [];
  const [textScale, updateTextScale] = useState(1); const fontSize = fontPxForScale(textScale);
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
  const inFlightInputs = useRef(0);
  const inFlightDrafts = useRef(new Map<LiveInput,number>());
  const boundaryDraft = useRef<(() => void) | undefined>(undefined);
  const leaseState = useRef<ReturnType<typeof claimTerminalDraft> | undefined>(undefined);
  // `live` is the active field's delivery mirror. The two composers retain
  // independent text/mirrors; a confirmed live prefix never becomes a command.
  const liveComposer = useRef<TerminalComposerDraft>({value:'',mirror:live.current,rejected:false});
  const bufferedComposer = useRef<TerminalComposerDraft>({value:'',mirror:new LiveInput(),rejected:false});
  const pastePending = useRef(false);
  const [buffered, setBuffered] = useState(false);
  const inputMode = useRef(false);
  const scaleState = useRef(textScale); scaleState.current = textScale;
  const [displayMode, setDisplayMode] = useState<'auto'|'desktop'>('auto');
  const requestedDisplayMode = useRef<'auto'|'desktop'>('auto');
  const observedDisplayMode = useRef<DisplayMode | undefined>(undefined);
  const [observedMode,setObservedMode]=useState<DisplayMode>();
  const recordDisplayMode = (mode:DisplayMode | undefined) => {observedDisplayMode.current=mode;setObservedMode(mode);};
  const [grid, setGrid] = useState('');
  const [pageReady,setPageReady]=useState(!Capacitor.isNativePlatform());
  const [displayBusy, setDisplayBusy] = useState(false);
  const displayPending = useRef(false);
  const viewportChain = useRef(Promise.resolve());
  const viewportGeneration = useRef(0);
  const subscribedId = useRef('');
  const surface = useRef<ReturnType<typeof attachTerminalSurface> | undefined>(undefined);
  const draftKey = JSON.stringify([hostId,sessionId]);
  const setTextScale = (scale:number) => {
    updateTextScale(scale);
    try {localStorage.setItem('remote-terminal.text-scale.v1',String(scale));}catch(e){setInputError(String(e));}
  };
  const [layout, setLayout] = useState<TerminalAccessoryLayout>(() => normalizeTerminalAccessoryLayoutPreference(null));
  const persistLayout = (next:TerminalAccessoryLayout) => {
    try { const value=createTerminalAccessoryLayoutPreference(next);localStorage.setItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,JSON.stringify(value));setLayout(value);setInputError(''); }
    catch(e){setInputError(String(e));}
  };
  const captureDraft = (input:HTMLTextAreaElement | null) => {
    const active={value:input?.value || '',mirror:live.current,rejected:rejectedDraft.current};
    if(inputMode.current)bufferedComposer.current=active;else liveComposer.current=active;
    return {live:liveComposer.current,bufferedDraft:bufferedComposer.current,buffered:inputMode.current};
  };
  useEffect(() => {
    try {const saved=Number(localStorage.getItem('remote-terminal.text-scale.v1'));if(TERMINAL_TEXT_SCALES.some(scale=>scale===saved))updateTextScale(saved);}catch(e){setInputError(String(e));}
    try { const value=localStorage.getItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY);setLayout(normalizeTerminalAccessoryLayoutPreference(value ? JSON.parse(value) : null)); }
    catch(e){setInputError(String(e));}
    const lease=claimTerminalDraft(draftKey);leaseState.current=lease;
    if(lease.draft && field.current) {
      liveComposer.current=lease.draft.live;bufferedComposer.current=lease.draft.bufferedDraft;
      inputMode.current=lease.draft.buffered;setBuffered(lease.draft.buffered);
      const active=lease.draft.buffered ? lease.draft.bufferedDraft : lease.draft.live;
      field.current.value=active.value;live.current=active.mirror;rejectedDraft.current=active.rejected;
      live.current.composing=false;
      if(live.current.uncertain)inputUncertain();
    }
    const token=crypto.randomUUID(),draftField=field.current;
    let disposed=false;
    // Font atlas and cell measurement may start only after Android has fixed
    // the WebView text zoom. Other routes retain the current system font scale.
    if(Capacitor.isNativePlatform())void RemoteTerminal.setTerminalPage({token,active:true}).then(()=>{if(!disposed)setPageReady(true);}).catch(e=>{if(!disposed)setError(String(e));});
    return () => {
      disposed=true;
      lease.save(captureDraft(draftField));
      if(Capacitor.isNativePlatform())void RemoteTerminal.setTerminalPage({token,active:false}).catch(()=>{});
    };
  },[draftKey]);
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
  const preserveInFlightDraft = () => {
    if(inFlightDrafts.current.has(live.current))live.current.uncertain=true;
    if(inFlightDrafts.current.size)boundaryDraft.current?.();
  };
  const resetField = () => {
    retireStaleDeliveries();
    // Lifecycle resets may retire echoed text, never unsent or ambiguous drafts.
    if (inputMode.current || rejectedDraft.current || queuedInputBytes.current || live.current.uncertain || live.current.composing || (field.current && field.current.value !== live.current.sentText)) return;
    live.current.reset(); if (field.current) field.current.value = '';
  };
  const inputHeld = () => setInputError(t('输入尚未发送，草稿已保留；恢复控制后继续编辑或按 Enter 重试。','Input was not sent. Draft kept; resume control and edit or press Enter to retry.'));
  const inputUncertain = () => setInputError(t('无法确认输入是否已送达。草稿已保留但不会重发；请检查终端后清空输入框，再继续输入。','Input delivery is unknown. Draft kept but will not be resent; check the terminal, then clear the input field before continuing.'));
  const modes = (): InputModes => {
    if (replaying.current) return replayModes.current;
    const term = terminal.current;
    return { applicationCursor: term?.modes.applicationCursorKeysMode ?? false,
      bracketedPaste: term?.modes.bracketedPasteMode ?? false, altScreen: term?.buffer?.active.type === 'alternate',
      kittyFlags: (term as KittyCore | null)?._core?.coreService?.kittyKeyboard?.flags };
  };
  const acceptInput = (data: string): boolean => {
    if (!isTerminalSendWithinLimit(data)) { setInputError(t('输入超过 64 KiB，请缩短后重试','Input exceeds 64 KiB; shorten it and retry')); return false; }
    if (queuedInputBytes.current + terminalInputByteLength(data) > 256 * 1024) { setInputError(t('输入队列已满，请稍后重试','Input queue full; retry shortly')); return false; }
    return true;
  };
  // Admission is synchronous; completion is not. Mirror ownership begins only
  // after this queue accepts the exact encoded bytes for the current input epoch.
  const admitSend = (data: string, delivery?: LiveInputDelivery, fieldOwned = !inputMode.current): Promise<boolean> | null => {
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
      inFlightInputs.current++;
      if(fieldOwned)inFlightDrafts.current.set(mirror,(inFlightDrafts.current.get(mirror) || 0)+1);
      try { await request(hostId,'terminal.send',{sessionId,data}); return true; }
      catch {
        canSend.current = false; setOwner(false);
        if (delivery) delivery.uncertain(); else if(fieldOwned)mirror.uncertain = true;
        invalidateInput(); inputUncertain(); return false;
      } finally {
        inFlightInputs.current--;
        if(fieldOwned) {
          const pending=(inFlightDrafts.current.get(mirror) || 1)-1;
          if(pending)inFlightDrafts.current.set(mirror,pending);else inFlightDrafts.current.delete(mirror);
        }
      }
    }).finally(() => { queuedInputBytes.current -= byteLength; });
    return sendChain.current;
  };
  const send = (data: string): Promise<boolean> => admitSend(data) ?? Promise.resolve(false);
  const changeText = (flushBuffered = false) => {
    if(inputMode.current && !flushBuffered) {
      // Explicit empty editing acknowledges a local reset, never a remote
      // Enter/backspace or a retry of the ambiguous command.
      if(field.current?.value==='' && !live.current.composing && (live.current.uncertain || rejectedDraft.current)) {
        live.current.reset();rejectedDraft.current=false;setInputError('');
      }
      return true;
    }
    retireStaleDeliveries();
    if (!field.current) return true;
    const mirror = live.current;
    const sticky = modifierState.current;
    const text = mirror.change(field.current.value, (payload, delivery) => {
      const encoded=inputMode.current && !mirror.sentText ? encodePaste(payload,modes()) : encodeModifiedText(payload,sticky,modes());
      if(encoded === null) { setInputError(t('当前修饰键无法编码部分输入，草稿已保留。请关闭修饰键或启用 Kitty 键盘协议后重试。','Some input cannot be encoded with these modifiers. Draft kept; turn off the modifiers or enable Kitty keyboard support and retry.')); return false; }
      return admitSend(encoded, {
        cancelled: () => { delivery.cancelled(); if (live.current === mirror) { rejectedDraft.current = true; if (mirror.uncertain) inputUncertain(); else inputHeld(); } },
        uncertain: () => { delivery.uncertain(); if (live.current === mirror) rejectedDraft.current = true; },
      },true) !== null;
    });
    rejectedDraft.current = text === null;
    if (mirror.uncertain) inputUncertain();
    else if (text !== null) setInputError('');
    return text !== null;
  };
  const sendExternal = (data:string):Promise<boolean> => {
    let unknown=false;
    const result=admitSend(data,{cancelled:inputHeld,uncertain:()=>{unknown=true;}},false);
    return (result ?? Promise.resolve(false)).then(accepted=>{
      if(unknown && alive.current)setInputError(t('无法确认外部输入是否送达；不会自动重发。草稿未提交，请检查终端后重试。','External input delivery is unknown; it will not be resent automatically. Draft was not submitted. Check the terminal before retrying.'));
      return accepted;
    });
  };
  const sendAfterText = (data: string, submitBuffered = false): Promise<boolean> => {
    retireStaleDeliveries();
    if (live.current.composing || !acceptInput(data)) return Promise.resolve(false);
    if(inputMode.current && !submitBuffered)return sendExternal(data);
    // Empty-field controls need no mirror reset and remain freely repeatable.
    if (!field.current?.value && !live.current.sentText) return send(data);
    // Do not overwrite ownership of a draft still attached to an unsettled
    // Enter/paste/preset. Typing and ordinary accessory keys keep their queue.
    if (boundaryPending.current) { setInputError(t('上一条提交尚未完成，本次提交未发送，草稿已保留；完成后请重试。','Previous submission is pending. This submission was not sent; draft kept. Retry after it completes.')); return Promise.resolve(false); }
    if (!changeText(true)) return Promise.resolve(false);
    const previous = live.current, draftField=field.current, draft = draftField?.value || '';
    const next = new LiveInput();
    const restore = (uncertain: boolean) => {
      if (uncertain) previous.uncertain = true;
      if (live.current !== next) return;
      previous.composing = next.composing; live.current = previous;
      if (draftField) draftField.value = draft + draftField.value;
      rejectedDraft.current = true;
      if (uncertain || previous.uncertain) inputUncertain(); else inputHeld();
    };
    const result = admitSend(data, {cancelled: () => restore(false), uncertain: () => restore(true)},true);
    if (!result) return Promise.resolve(false);
    boundaryDraft.current=()=>restore(true);
    boundaryPending.current = true; setInputBusy(true);
    live.current = next; rejectedDraft.current = false;
    if (field.current) field.current.value = '';
    return result.finally(() => { boundaryDraft.current=undefined;boundaryPending.current = false; if(alive.current)setInputBusy(false); });
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
    if (binding.key === 'enter') return sendAfterText(data,true);
    if (live.current.composing || !acceptInput(data) || !changeText()) return Promise.resolve(false);
    return send(data);
  };
  const updateViewport = async (nextMode = requestedDisplayMode.current, force = false) => {
    const term=terminal.current, frame=element.current;
    if(!term || !frame) return;
    if(surface.current)surface.current.fit();else applyGridScale(term,frame);surface.current?.reposition();
    if(!canSend.current || !subscribedId.current || (!force && nextMode==='desktop')) return;
    if(!observedDisplayMode.current) {
      setError(t('主机需要更新以支持 Orca 显示模式。','Update the host to support Orca display modes.'));return;
    }
    const viewport=nextMode==='auto' ? phoneViewport(term,frame) : null;
    if(nextMode==='auto' && !viewport) {if(force)setError(t('视口太小，无法手机适配（至少 20 列）。','Viewport is too small for phone fit (minimum 20 columns).'));return;}
    if(!force && viewport && observedDisplayMode.current==='phone' && viewport.cols===term.cols && viewport.rows===term.rows) return;
    const generation=viewportGeneration.current, epoch=inputEpoch.current;
    const id=subscribedId.current;
    viewportChain.current=viewportChain.current.catch(()=>{}).then(async()=>{
      if(!alive.current || !canSend.current || epoch!==inputEpoch.current || generation!==viewportGeneration.current || id!==subscribedId.current || (!force && nextMode!==requestedDisplayMode.current)) return;
      const result=await request<{session:Session;snapshot:Snapshot}>(hostId,'terminal.displayModeSet',{sessionId,subscriptionId:id,displayMode:nextMode,...(viewport ? {viewport} : {})});
      if(!alive.current || epoch!==inputEpoch.current || generation!==viewportGeneration.current || id!==subscribedId.current) return;
      recordDisplayMode(result.session.displayMode);
      if(force) { requestedDisplayMode.current=nextMode;setDisplayMode(nextMode); }
    });
    await viewportChain.current;
  };
  const toggleDisplayMode = async () => {
    if(displayPending.current || !canSend.current) return;
    displayPending.current=true;setDisplayBusy(true);viewportGeneration.current++;
    try { await updateViewport(requestedDisplayMode.current==='auto'?'desktop':'auto',true); }
    catch(e) { setError(t('显示模式切换失败（请确认主机已更新）：','Display mode failed (check host version): ')+String(e)); }
    finally { displayPending.current=false;if(alive.current)setDisplayBusy(false); }
  };
  const toggleInputMode = () => {
    if(live.current.uncertain) {inputUncertain();return;}
    if(live.current.composing || rejectedDraft.current || boundaryPending.current || pastePending.current || queuedInputBytes.current || inFlightInputs.current) {inputHeld();return;}
    const input=field.current;if(!input)return;
    if(!inputMode.current && input.value!==live.current.sentText) {inputHeld();return;}
    captureDraft(input);
    if(!inputMode.current) {
      // Retire only acknowledged live text. This is local bookkeeping, never
      // a remote erase or a flush of unconfirmed edits.
      live.current.reset();liveComposer.current={value:'',mirror:live.current,rejected:false};
    }
    inputMode.current=!inputMode.current;setBuffered(inputMode.current);
    const next=inputMode.current ? bufferedComposer.current : liveComposer.current;
    input.value=next.value;live.current=next.mirror;rejectedDraft.current=next.rejected;
    if(next.mirror.uncertain)inputUncertain();
  };
  const paste = async (readText:()=>Promise<string> = readTerminalClipboard) => {
    if(live.current.uncertain) {inputUncertain();return;}
    if(pastePending.current || boundaryPending.current || live.current.composing) {inputHeld();return;}
    pastePending.current=true;
    const epoch=inputEpoch.current;
    const current=()=>alive.current && epoch===inputEpoch.current && canSend.current;
    try {
      const text=await readText();
      if(!current()) {inputHeld();return;}
      if(live.current.composing) {inputHeld();return;}
      if(!text) {setInputError(t('剪贴板中没有文本。','Clipboard contains no text.'));return;}
      if(!acceptInput(encodePaste(text,modes())))return;
      // Buffered text is never involved. Live deltas must settle before the
      // clipboard can dispatch, and an owner/session epoch change cancels it.
      if(!inputMode.current && !changeText())return;
      const hadPending=queuedInputBytes.current>0;
      const flushed=await sendChain.current;
      if(!current() || (hadPending && !flushed) || live.current.composing || live.current.uncertain) {inputHeld();return;}
      const data=encodePaste(text,modes());
      if(inputMode.current)await sendExternal(data);else await sendAfterText(data);
    } catch(e){setInputError(t('无法读取剪贴板：','Clipboard read failed: ')+String(e));}
    finally {pastePending.current=false;}
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
      if (!inputMode.current && e.inputType === 'deleteContentBackward' && !live.current.composing && !input?.value) {
        e.preventDefault(); void special({key:'backspace',modifiers:modifierState.current});
      }
    };
    input?.addEventListener('beforeinput',eraseEmptyField);
    return () => { unbind(); input?.removeEventListener('beforeinput',eraseEmptyField); };
  }, []);
  useEffect(() => {
    if(!pageReady)return;
    alive.current = true;
    const draftField=field.current;
    let disposed = false, initialized = false, reconnecting = false, seq = -1;
    let pending: TerminalEvent[] = [], pendingSize = 0, writeBytes = 0;
    let outputChain = Promise.resolve();
    let generation = 0;
    const subscriptionId = crypto.randomUUID(); subscribedId.current=subscriptionId;
    void RemoteTerminal.listHosts().then(({hosts}) => { if (!disposed) setHostName(hosts.find(h => h.id === hostId)?.name || ''); }).catch(() => {});
    let listener: Awaited<ReturnType<typeof RemoteTerminal.addListener>> | undefined;
    let appListener: Awaited<ReturnType<typeof CapacitorApp.addListener>> | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const term = new Terminal({ allowProposedApi:true, disableStdin:true, scrollback:5000,
      fontSize:fontPxForScale(scaleState.current),fontFamily:terminalFontFamily(),fontWeight:'300',fontWeightBold:'500',
      ...MOBILE_TERMINAL_CARET_OPTIONS, vtExtensions:{kittyKeyboard:true}, theme:{...DEFAULT_TERMINAL_THEME} });
    terminal.current = term;
    term.loadAddon(new Unicode11Addon());
    activateOrcaTerminalUnicodeProvider(term);
    term.open(element.current!);
    // No onData/onBinary bridge: only host answers parser DA/CPR queries.
    const applyTheme = () => { term.options.theme={...DEFAULT_TERMINAL_THEME}; };
    const renderer = attachTerminalRenderer(term, () => new WebglAddon(), applyTheme);
    const gestures=attachTerminalSurface(term,element.current!,{
      scale:()=>scaleState.current,commitScale:setTextScale,
      scroll:(lines,x,y)=>{const current=scope();if(current)routeScrollLines(current,lines,x,y);},
      tap:(x,y)=>{const current=scope();if(current){const bytes=buildMouseClickInput(current,x,y);if(bytes)current.send(bytes);else if(canSend.current)field.current?.focus();}},
      copy:writeTerminalClipboard,error:e=>setInputError(String(e)),
      copyLabel:t('复制','Copy'),clearLabel:t('完成','Done'),allLabel:t('全选','Select all'),
      panUpLabel:t('显示较早屏幕行','Earlier screen rows'),panDownLabel:t('显示较后屏幕行','Later screen rows'),revealLabel:t('显示光标','Reveal cursor'),
    });surface.current=gestures;
    let fitFrame=0,fitAttempts=0;
    const fitGrid=()=>{
      cancelAnimationFrame(fitFrame);fitAttempts=0;
      const attempt=()=>{
        if(disposed)return;
        if(!gestures.fit() && document.visibilityState==='visible' && ++fitAttempts<60)fitFrame=requestAnimationFrame(attempt);
        gestures.reposition();
      };fitFrame=requestAnimationFrame(attempt);
    };fitGrid();
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme); themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const systemTheme = matchMedia('(prefers-color-scheme: dark)'); systemTheme.addEventListener('change',applyTheme);
    const presentation={statusDotPendingSelector:false};
    const write = (data: string) => new Promise<void>(resolve => term.write(normalizeStatusDotPresentation(presentation,data),()=>{fitGrid();resolve();}));
    const refreshOwner = () => {
      const next = initialized && sessionState.current?.status === 'running' && sessionState.current.ownerClientId === clientId.current;
      canSend.current = next; setOwner(next);
      if (!next) { invalidateInput(); repeat.current.stop(); resetField(); }
    };
    const snapshot = async (value: Snapshot, display?:DisplayMode) => {
      // Resize snapshots must not cancel an active IME composition or discard queued input.
      // Retain the last parsed modes while xterm briefly resets and replays equivalent state.
      replayModes.current = modes(); replaying.current = true;
      const scrollAnchor=Math.max(0,term.buffer.active.baseY-term.buffer.active.viewportY);
      gestures.reset();presentation.statusDotPendingSelector=false;
      term.reset(); activateOrcaTerminalUnicodeProvider(term); term.resize(value.cols,value.rows);
      if(display)recordDisplayMode(display);
      setGrid(value.cols+' × '+value.rows);
      await write(value.ansi);
      term.scrollToLine(Math.max(0,term.buffer.active.baseY-scrollAnchor));
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
        if (event.snapshot.seq >= seq) await snapshot(event.snapshot,event.displayMode);
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
        const viewport=phoneViewport(term,element.current!);
        const result = await request<{session:Session;snapshot:Snapshot}>(hostId,'terminal.subscribe',{sessionId,subscriptionId,displayMode:requestedDisplayMode.current,...(viewport && requestedDisplayMode.current==='auto' ? {viewport} : {})});
        if (!valid()) { if (disposed) void request(hostId,'terminal.unsubscribe',{sessionId,subscriptionId}).catch(() => {}); return; }
        await outputChain;
        if (!valid()) return;
        recordDisplayMode(result.session.displayMode);
        sessionState.current = result.session; setSession(result.session);
        await snapshot(result.snapshot);
        if (!valid()) return;
        initialized = true; setConnected(true); setRecovering(false); setMissing(false); setError(result.session.displayMode ? '' : t('主机需要更新以支持 Orca 显示模式。','Update the host to support Orca display modes.')); refreshOwner();
        pending.splice(0).forEach(enqueue); pendingSize = 0;
        fitGrid();void updateViewport().catch(e=>setError(String(e)));
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
        if (state.isActive) {renderer.resume();fitGrid();void recovery.resume();}
        else { recovery.pause(); generation++; initialized = false; setConnected(false); invalidateInput(); canSend.current = false; setOwner(false); repeat.current.stop(); resetField(); }
      });
      if (disposed) { await appListener.remove(); return; }
      await recovery.wake();
    })().catch(fail);
    const resize = () => { fitGrid();clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { void updateViewport().catch(e => setError(String(e))); }, 150); };
    const shown=()=>{if(document.visibilityState==='visible')resize();};
    document.addEventListener('visibilitychange',shown);
    const observer = new ResizeObserver(resize); observer.observe(element.current!);
    window.visualViewport?.addEventListener('resize',resize);
    return () => {
      recovery.dispose(); disposed = true; alive.current = false; generation++; invalidateInput(); canSend.current = false; repeat.current.stop();
      preserveInFlightDraft();
      leaseState.current?.save(captureDraft(draftField));
      subscribedId.current='';viewportGeneration.current++;cancelAnimationFrame(fitFrame);gestures.dispose();surface.current=undefined;
      clearTimeout(resizeTimer); observer.disconnect(); themeObserver.disconnect(); systemTheme.removeEventListener('change',applyTheme);
      window.visualViewport?.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',shown);
      void listener?.remove(); void appListener?.remove();
      void request(hostId,'terminal.unsubscribe',{sessionId,subscriptionId}).catch(() => {});
      // Neither back nor background closes the shell.
      renderer.dispose(); term.dispose(); terminal.current = null; cancelAnimationFrame(viewportFrame.current ?? 0);
    };
  }, [hostId, sessionId,pageReady]);
  useEffect(() => {
    const term=terminal.current;if(term)term.options.fontSize=fontSize;
    viewportFrame.current=requestAnimationFrame(()=>{void updateViewport().catch(e=>setError(String(e)));});
    return ()=>cancelAnimationFrame(viewportFrame.current ?? 0);
  }, [fontSize,owner]);
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); setError(''); } catch (e) { setError(String(e)); } };
  const pressed = useRef(new Map<string, HardwareBinding>());
  const scope = (): GestureScope | null => {
    const term = terminal.current; const screen = element.current?.querySelector('.xterm-screen');
    if (!term || !screen) return null;
    const encoding = readTerminalMouseEncoding(term);
    return {term,rect:screen.getBoundingClientRect(),mouseEncodingKnown:true,sgrMouseMode:encoding === 'sgr',sgrMousePixelsMode:encoding === 'sgr-pixels',
      send: bytes => { if (isTerminalGestureInput(bytes)) void send(bytes); }};
  };
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
    const binding = terminalAccessoryBinding(k.id);
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
      <small className="rt-grid-info" aria-live="polite">{Math.round(textScale*100)}% · {grid} · {observedMode==='phone'?'Phone':observedMode==='desktop'?'Desktop':'Auto'}</small>
      <button className="icon-button" aria-label={t('终端选项','Terminal options')} onClick={() => setMenu(true)}><Ellipsis/></button>
    </header>
    <SessionTabs hostId={hostId} sessionId={sessionId} session={session} connected={connected} navigate={leave}/>
    <ErrorNotice error={inputError || error}/>
    <Dialog sheet className="rt-sheet" open={menu} onOpenChange={setMenu} title={t('终端选项','Terminal options')}>
      <div className="rt-menu">
        {owner && <button disabled={controlBusy} onClick={() => {setMenu(false); void control();}}>{t('释放控制','Release control')}</button>}
        <button onClick={() => { setMenu(false); void reconnect.current(); }}>{connected ? t('重新同步','Resync') : t('重新连接','Reconnect')}</button>
        <button disabled={!owner} onClick={() => { setMenu(false); void run(() => updateViewport('auto',true)); }}>{t('适应屏幕','Fit to screen')}</button>
        <div className="rt-size"><span>{t('文字大小','Text size')} · {fontSize}px</span><select aria-label={t('文字大小','Text size')} value={textScale} onChange={e=>setTextScale(Number(e.target.value))}>{TERMINAL_TEXT_SCALES.map(scale=><option key={scale} value={scale}>{scale*100}%</option>)}</select></div>
        <button onClick={() => {surface.current?.selectCenter();field.current?.blur();setMenu(false);}}>{t('选择终端文本','Select terminal text')}</button>
        <button onClick={() => { const term=terminal.current; if (term) setSelectionText(term.getSelection() || Array.from({length:term.rows},(_,i) => term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true) ?? '').join('\n')); setMenu(false); }}>{t('复制终端文本','Copy terminal text')}</button>
        <p className="secondary">{t('离开页面不会结束电脑上的 Shell。终端目前仅支持文本。','Leaving keeps your desktop shell running. Text terminals are supported.')}</p>
      </div>
    </Dialog>
    <Dialog sheet className="rt-sheet" open={selectionText !== undefined} onOpenChange={open => { if (!open) setSelectionText(undefined); }} title={t('复制文本','Copy text')}>
      <div className="rt-copy"><textarea readOnly aria-label={t('可复制的终端文本','Terminal text to copy')} value={selectionText || ''} onFocus={e => e.currentTarget.select()}/><button className="rt-primary" onClick={() => void run(() => writeTerminalClipboard(selectionText || ''))}>{t('复制文本','Copy text')}</button></div>
    </Dialog>
    <div ref={element} className="rt-screen"/>
    <footer className="rt-dock" data-keyboard-open={keyboardOpen}>
    <Presets disabled={!owner || live.current.composing} activeModifiers={modifiers}
      send={preset => {if (preset.kind === 'chord') void special(preset.chord); else void sendAfterText(presetInput(preset,modes()));}}
      accessoryKeys={<>
        <AccessoryButton disabled={!owner || displayBusy} label={t('切换手机/桌面显示','Toggle phone/desktop display')} onPress={()=>void toggleDisplayMode()}>{displayMode==='auto'?t('桌面显示','Desktop'):t('手机显示','Phone')}</AccessoryButton>
        <AccessoryButton label={t('切换实时/缓冲输入','Toggle live/buffered input')} onPress={toggleInputMode}>{buffered?'Buffered':'Live'}</AccessoryButton>
        <AccessoryButton disabled={!owner} label={t('粘贴','Paste')} onPress={()=>void paste()}>Paste</AccessoryButton>
        {getVisibleTerminalAccessoryKeys(layout.visibleBuiltInIds).map(keyButton)}
      </>}
      builtInEditor={<div className="rt-built-in-editor"><h3>{t('内置按键','Built-in keys')}</h3>{layout.orderedBuiltInIds.map((id,index)=>{
        const label=TERMINAL_ACCESSORY_KEYS.find(key=>key.id===id)?.label || id;
        const move=(delta:number)=>{const ids=[...layout.orderedBuiltInIds];[ids[index],ids[index+delta]]=[ids[index+delta],ids[index]];persistLayout(reorderTerminalAccessoryBuiltInIds(layout,ids));};
        return <div key={id}><label><input type="checkbox" checked={layout.visibleBuiltInIds.includes(id)} onChange={e=>persistLayout(setTerminalAccessoryBuiltInVisible(layout,id,e.target.checked))}/>{label}</label>
          <button disabled={index===0} aria-label={t('上移 ','Move up ')+label} onClick={()=>move(-1)}><ArrowUp size={16}/></button>
          <button disabled={index===layout.orderedBuiltInIds.length-1} aria-label={t('下移 ','Move down ')+label} onClick={()=>move(1)}><ArrowDown size={16}/></button></div>;
      })}</div>}/>
    <div className="rt-live-row"><textarea ref={field} className="rt-live-input" disabled={!owner && !buffered} rows={1} aria-busy={inputBusy}
      aria-label={buffered ? t('缓冲终端草稿','Buffered terminal draft') : t('实时终端输入（支持中文输入法）','Live terminal input (IME supported)')} placeholder={inputBusy ? t('正在发送…','Sending…') : buffered ? t('缓冲草稿 · Enter 提交','Buffered draft · Enter to submit') : !owner ? t('接管后即可输入','Take control to type') : t('实时输入…','Type live…')}
      autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="send"
      onFocus={() => surface.current?.revealCursor()}
      onCompositionStart={() => { live.current.composing=true; }}
      onCompositionEnd={() => { live.current.composing=false; changeText(); }}
      onInput={() => changeText()}
      onPaste={e => {e.preventDefault();const text=e.clipboardData.getData('text');void paste(async()=>text);}}
      onKeyDown={e => {
        if(live.current.composing) return;
        if(inputMode.current && !(e.key==='Enter' && !e.nativeEvent.shiftKey && !e.nativeEvent.altKey && !e.nativeEvent.ctrlKey && !e.nativeEvent.metaKey)) return;
        // Rejected unsent drafts remain locally editable without flushing or remote deletion.
        if (rejectedDraft.current && (Array.from(e.key).length === 1 || ['Backspace','Delete','ArrowLeft','ArrowRight','Home','End'].includes(e.key))) return;
        const input=hardwareKeyDown(e.nativeEvent,modes(),modifiers);
        if(!input) return;
        e.preventDefault(); if(!inputMode.current)pressed.current.set(e.code,input.binding); void special(input.binding,input.eventType);
      }}
      onKeyUp={e => { const binding=pressed.current.get(e.code); if(!binding) return; pressed.current.delete(e.code); const release=hardwareBinding(e.nativeEvent); release.modifiers=[...new Set([...release.modifiers,...modifiers])]; void send(encodeKey(release,modes(),3)); }}
      onBlur={() => { repeat.current.stop(); pressed.current.clear(); }}
    />{!owner && session?.status !== 'exited' ? <button className="rt-primary rt-control" disabled={!connected || controlBusy || missing} onClick={() => void control()}>{controlBusy ? t('请稍候…','Wait…') : t('接管输入','Take control')}</button> : <button className="rt-keyboard-toggle" disabled={!owner} onPointerDown={e => e.preventDefault()} onClick={() => { if(document.activeElement === field.current) field.current?.blur(); else field.current?.focus(); }} aria-label={t('显示或隐藏键盘','Show or hide keyboard')}><Keyboard size={20}/></button>}</div>
    </footer>
    <Dialog sheet className="rt-sheet" open={!!leaveTo} onOpenChange={open => {if (!open) setLeaveTo(undefined);}} title={t('保留当前输入？','Keep this input?')}><p>{t('部分输入尚未确认送达。离开后保留本会话草稿，已送出的输入不会撤回。','Some input has not been confirmed. The draft is kept for this session; input already sent cannot be recalled.')}</p><div className="rt-dialog-actions"><button className="rt-primary" onClick={() => setLeaveTo(undefined)}>{t('留在会话','Stay here')}</button><button className="rt-danger" onClick={() => {if (leaveTo) nav(leaveTo);}}>{t('保留草稿并离开','Keep draft and leave')}</button></div></Dialog>
  </main>;
}
