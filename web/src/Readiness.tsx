import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Device, NativeSettings } from './native';
import { RemoteTerminal } from './RemoteTerminal/native';
import { ConfirmDialog } from './components/ui/dialog';
import { Header, Row, Section, useText, query } from './ui';
import { computerGuidance, fresh, modelTestState, observe, phoneGuidance, type ModelReadiness, type ProviderCheck, type ReadinessSnapshot } from './readiness';

export function ReadinessPage() {
  const t = useText(), nav = useNavigate();
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot>();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false), [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState<ModelReadiness>();
  const [check, setCheck] = useState<ProviderCheck>();
  const [notice, setNotice] = useState('');
  const alive = useRef(false), generation = useRef(0), checking = useRef(false);
  const probe = useRef<AbortController | undefined>(undefined);
  const refresh = async () => {
    if (!alive.current || document.hidden) return;
    const id = ++generation.current;
    setBusy(true);
    const [model, device, computer] = await Promise.all([
      observe(() => NativeSettings.readiness()),
      observe(() => Device.capabilities()),
      observe(() => RemoteTerminal.readiness()),
    ]);
    if (!alive.current || id !== generation.current) return;
    setSnapshot({model, device, computer}); setNow(Date.now()); setBusy(false);
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    const visible = () => {
      setConfirm(undefined);
      if (document.hidden) {
        ++generation.current; setBusy(false); probe.current?.abort();
        setSnapshot(current => current && ({
          model: {...current.model, checkedAt: 0}, device: {...current.device, checkedAt: 0},
          computer: {...current.computer, checkedAt: 0},
        }));
      } else void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    const changed = () => { if (alive.current && !document.hidden) void refresh(); };
    const deviceListener = Device.addListener('deviceEvent', changed).catch(() => undefined);
    const terminalListener = RemoteTerminal.addListener('terminalEvent', event => {
      if (event.event === 'connection') changed();
    }).catch(() => undefined);
    return () => {
      alive.current = false; ++generation.current; probe.current?.abort();
      clearInterval(timer); document.removeEventListener('visibilitychange', visible);
      void deviceListener.then(listener => listener?.remove());
      void terminalListener.then(listener => listener?.remove());
    };
  }, []);
  const runTest = async () => {
    const approved = confirm;
    if (!approved || checking.current) return;
    checking.current = true; setConfirm(undefined); setTesting(true); setNotice(''); setCheck(undefined);
    const controller = new AbortController(); probe.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const before = (await observe(() => NativeSettings.readiness())).value;
      if (!before) throw new Error('Local configuration unavailable');
      if (before.revision !== approved.revision || before.provider !== approved.provider) {
        if (alive.current) setNotice(t('配置已变化，请刷新并重新确认测试。', 'Configuration changed. Refresh and confirm the test again.'));
        return;
      }
      if (controller.signal.aborted || !alive.current) return;
      const result = await query<{model: string}>('test_provider', {providerId: approved.provider, expectedReadinessRevision: approved.revision}, undefined, controller.signal);
      const after = (await observe(() => NativeSettings.readiness())).value;
      if (!after) throw new Error('Local configuration unavailable');
      if (!alive.current || controller.signal.aborted) return;
      if (after.revision !== approved.revision) {
        setCheck(undefined); setNotice(t('测试期间配置发生变化，结果不再适用。', 'Configuration changed during the test. Its result no longer applies.'));
      } else setCheck({provider: approved.provider, model: result.model, revision: approved.revision, checkedAt: Date.now(), passed: true});
    } catch {
      if (alive.current) {
        setCheck({provider: approved.provider, model: approved.model, revision: approved.revision, checkedAt: Date.now(), passed: false});
        setNotice(t('测试未完成或失败。检查服务商配置与网络后手动重试；不会自动重试。', 'Test failed or was cancelled. Check provider settings and network, then retry manually.'));
      }
    } finally {
      clearTimeout(timeout); checking.current = false;
      if (probe.current === controller) probe.current = undefined;
      if (alive.current) { setTesting(false); if (!document.hidden) void refresh(); }
    }
  };
  const model = snapshot && fresh(snapshot.model.checkedAt, now) ? snapshot.model.value : undefined;
  const device = snapshot && fresh(snapshot.device.checkedAt, now) ? snapshot.device.value : undefined;
  const computer = snapshot && fresh(snapshot.computer.checkedAt, now) ? snapshot.computer.value : undefined;
  const currentModel = model;
  const testState = modelTestState(currentModel, check, now);
  const unknown = t('未确认', 'Unknown');
  const flag = (value: boolean | undefined, yes: string, no: string) => value === undefined ? unknown : value ? yes : no;
  const age = (at: number | undefined) => !at || !fresh(at, now)
    ? t('状态已过期，请刷新。', 'Status is stale. Refresh to check again.')
    : t('本地状态检查于 ', 'Local status checked at ') + new Date(at).toLocaleTimeString();
  const stale = snapshot && [snapshot.model, snapshot.device, snapshot.computer].some(item => !fresh(item.checkedAt, now));
  const testLabel = {
    untested: t('尚未测试', 'Not tested'),
    stale: t('结果已过期', 'Result is stale'),
    passed: t('默认模型请求通过', 'Default model request passed'),
    otherModel: t('服务商的其他模型请求通过', 'Another provider model passed'),
    failed: t('失败或已取消', 'Failed or cancelled'),
  }[testState];
  return <main className="page readiness-page">
    <Header title={t('配置就绪与能力检查', 'Setup & capability checks')} actions={<button className="icon-button" aria-label={t('刷新本地状态', 'Refresh local status')} disabled={busy || testing} onClick={() => void refresh()}><RefreshCw className={busy ? 'spin' : ''}/></button>}/>
    <p className="secondary">{t('这里只读取本地配置和现有连接，不自动授权、启动虚拟屏或连接电脑。状态 60 秒后过期；付费模型测试需要另行确认。', 'This screen reads local configuration and existing connections. It does not grant permissions, create displays, or connect computers. Status expires after 60 seconds; a model request needs separate confirmation.')}</p>
    <p role="status" aria-live="polite">{busy ? t('正在检查本地状态…', 'Checking local status…') : stale ? t('部分状态已过期，请刷新。', 'Some status is stale. Please refresh.') : ''}</p>
    <Section title={t('聊天', 'Chat')}>
      <Row title={t('安装状态 · Pi 运行资源', 'Installation · Pi runtime assets')} detail={flag(device?.piInstalled, t('资源存在，尚未验证启动', 'Assets present; startup not verified'), t('缺少资源，需完整 APK 覆盖更新', 'Assets missing; update with a complete APK'))}/>
      <Row title={t('配置状态 · 启动默认模型', 'Configuration · Startup model')} detail={model ? (model.selectionConfigured ? model.provider + ' / ' + model.model : t('尚未选择完整的默认服务商与模型', 'Choose a default provider and model')) : unknown}/>
      <Row title={t('已保存凭据', 'Saved credential')} detail={model ? model.credentialSaved ? t('存在已保存的凭据配置，未验证有效性', 'Credential configuration saved; validity not checked') : t('未找到已保存凭据；环境变量或免密服务仍可能可用', 'No saved credential found; environment or keyless services may still work') : unknown}/>
      <Row title={t('连接状态 · 模型服务', 'Connection · Model service')} detail={testState === 'passed' || testState === 'otherModel' ? t('最近一次请求成功；不代表持续在线', 'A recent request succeeded; continuous connectivity is not guaranteed') : t('未验证网络连接', 'Network connectivity is not verified')}/>
      <Row title={t('测试状态 · 本页请求', 'Test · Request on this page')} detail={testLabel + (check ? ' · ' + new Date(check.checkedAt).toLocaleTimeString() : '')}/>
      <p className="secondary">{age(snapshot?.model.checkedAt)}</p>
      <p className="secondary">{t('这里只检查启动默认值，当前聊天可以单独选模型。服务商测试使用第一个模型；其他模型成功不证明默认模型可用。', 'These are startup defaults; each chat can select a different model. The provider test uses its first model, so another model passing does not verify the default model.')}</p>
      <Row title={t('配置服务商与凭据', 'Configure providers & credentials')} onClick={() => nav('/settings/providers')}/>
      <Row title={t('选择启动默认模型', 'Choose startup model')} onClick={() => nav('/settings/advanced')}/>
      <button className="button" disabled={!currentModel?.selectionConfigured || busy || testing} onClick={() => setConfirm(currentModel)}>{testing ? t('正在测试…', 'Testing…') : t('测试模型服务（需确认）', 'Test model service (confirm first)')}</button>
      {testing && <button className="button secondary-button" onClick={() => probe.current?.abort()}>{t('取消测试', 'Cancel test')}</button>}
      {notice && <p role="status" className="secondary">{notice}</p>}
    </Section>
    <Section title={t('操作手机', 'Phone control')}>
      <Row title={t('安装状态 · Shizuku / Shower', 'Installation · Shizuku / Shower')} detail={device ? flag(device.shizukuInstalled, t('Shizuku 已安装', 'Shizuku installed'), t('Shizuku 未安装', 'Shizuku missing')) + ' · ' + flag(device.showerInstalled, t('Shower 资源存在', 'Shower assets present'), t('Shower 资源缺失', 'Shower assets missing')) : unknown}/>
      <Row title={t('配置状态 · Shizuku 授权', 'Configuration · Shizuku permission')} detail={!device ? unknown : device.shizukuPermission === 'granted' ? t('已授权', 'Granted') : device.shizukuPermission === 'denied' ? t('授权被拒绝', 'Denied') : device.shizukuPermission === 'notGranted' ? t('尚未授权', 'Not granted') : unknown}/>
      <Row title={t('连接状态 · Shizuku', 'Connection · Shizuku')} detail={flag(device?.shizukuRunning, t('Binder 当前可达', 'Binder currently reachable'), t('服务未运行或已断开', 'Service stopped or disconnected'))}/>
      <Row title={t('测试状态 · 虚拟屏', 'Test · Virtual display')} detail={device?.showerDisplayActive ? t('当前聊天虚拟屏存在；点击与输入尚未验证', 'Current chat has a display; taps and typing are not verified') : t('尚未验证虚拟屏操作', 'Virtual-display interaction is not verified')}/>
      <p className="secondary">{age(snapshot?.device.checkedAt)}</p><p>{phoneGuidance(device, t)}</p>
      <Row title={t('打开助手权限', 'Open Assistant permissions')} onClick={() => nav('/settings/device')}/>
    </Section>
    <Section title={t('连接电脑', 'Connect a computer')}>
      <Row title={t('安装状态 · 电脑端 e-desktop', 'Installation · Desktop e-desktop')} detail={t('需在电脑上确认应用已安装并打开「终端」', 'Check on the computer that e-desktop is installed and Terminal is open')}/>
      <Row title={t('配置状态 · 配对记录', 'Configuration · Saved pairing')} detail={computer ? String(computer.paired) + t(' 台已保存；不代表在线', ' saved; this does not mean online') : unknown}/>
      <Row title={t('连接状态 · 已认证套接字', 'Connection · Authenticated sockets')} detail={computer ? String(computer.connected) + t(' 个当前连接', ' current connections') : unknown}/>
      <Row title={t('测试状态 · 终端操作', 'Test · Terminal operations')} detail={t('尚未在本页发送命令；连接成功不代表 shell 或控制权可用', 'No commands are sent here; connection does not verify shell availability or input control')}/>
      <p className="secondary">{age(snapshot?.computer.checkedAt)}</p><p>{computerGuidance(computer, t)}</p>
      <Row title={t('打开远程终端并连接', 'Open Remote terminals & connect')} detail={t('已有配对时，终端页会尝试连接', 'The terminal page attempts to connect saved pairings')} onClick={() => nav('/terminals')}/>
    </Section>
    <ConfirmDialog open={!!confirm} title={t('发送模型测试请求？', 'Send a model test request?')} description={t('将通过现有 Pi 配置，向服务商 ', 'Using existing Pi configuration, send “ping” to the first model of provider ') + (confirm?.provider || '') + t(' 的第一个模型发送“ping”。可能产生费用，不发送聊天历史。测试不能保证其他模型可用。', '. Provider charges may apply. No chat history is sent. This does not verify other models.')} onCancel={() => setConfirm(undefined)} onConfirm={() => void runTest()}/>
  </main>;
}
