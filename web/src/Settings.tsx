import { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import * as Switch from '@radix-ui/react-switch';
import { Database, ExternalLink, FileText, Grid2X2, Hand, Info, Mic, Palette, Puzzle, RefreshCw, Settings, Share2, Shield, SlidersHorizontal } from 'lucide-react';
import { Device, NativeSettings, type DeviceState, type VoiceRemote, type VoiceState } from './native';
import { Dialog } from './components/ui/dialog';
import { Environment, ErrorNotice, Header, Row, Section, useAction, useText } from './ui';

export function SettingsHome() {
  const t = useText(); const nav = useNavigate();
  return <main className="page settings-home"><Header title={t('设置','Settings')}/><Section title={t('偏好','Preferences')}>
    <Row icon={<Settings/>} title={t('通用','General')} detail={t('语言与权限规则','Language & permission rules')} onClick={() => nav('/settings/general')}/>
    <Row icon={<Palette/>} title={t('外观','Appearance')} detail={t('主题与背景','Theme & background')} onClick={() => nav('/settings/appearance')}/>
    <Row icon={<Hand/>} title={t('桌面与手势','Home & gestures')} detail={t('默认桌面与系统权限','Default home & permissions')} onClick={() => nav('/settings/device')}/>
  </Section><Section title={t('AI 与工具','AI & tools')}>
    <Row icon={<Grid2X2/>} title={t('机器人','Bots')} detail={t('角色、协作与定时任务','Roles, collaboration & routines')} onClick={() => nav('/bots')}/>
    <Row icon={<FileText/>} title={t('全局 AGENTS.md','Global AGENTS.md')} detail={t('编辑与保存全局 Agent 指令','Edit and save global agent instructions')} onClick={() => nav('/settings/editor?project=false&file=AGENTS.md')}/>
    <Row icon={<Database/>} title={t('服务商与模型','Providers & models')} onClick={() => nav('/settings/providers')}/>
    <Row icon={<Mic/>} title={t('语音','Voice')} detail={t('识别、朗读与语音唤醒','Speech, read-aloud & wake word')} onClick={() => nav('/settings/voice')}/>
    <Row icon={<Puzzle/>} title={t('技能','Skills')} onClick={() => nav('/settings/resources/skills')}/>
    <Row icon={<Share2/>} title="MCP" onClick={() => nav('/settings/resources/mcp')}/>
    <Row icon={<Grid2X2/>} title={t('扩展','Extensions')} onClick={() => nav('/settings/resources/extensions')}/>
  </Section><Section title=""><Row icon={<SlidersHorizontal/>} title={t('高级配置','Advanced')} detail={t('全局、工作区与文件','Global, workspace & files')} onClick={() => nav('/settings/advanced')}/><Row icon={<Info/>} title={t('关于','About')} onClick={() => nav('/settings/about')}/></Section></main>;
}
export function Toggle({label, checked, onChange, disabled}: {label:string;checked:boolean;onChange(value:boolean):void;disabled?:boolean}) { return <Switch.Root className="switch" aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled}><Switch.Thumb/></Switch.Root>; }
export function GeneralPage() {
  const {device, refresh} = useContext(Environment); const action = useAction(); const t = useText(); const nav = useNavigate();
  if (!device) return null;
  return <main className="page"><Header title={t('通用','General')}/><Section title={t('语言','Language')}><Row title={t('界面语言','App language')}><select aria-label={t('界面语言','App language')} value={device.language} onChange={e => action.run(async () => { await Device.setAppearance({language:e.target.value as DeviceState['language']}); await refresh(); })}><option value="system">{t('跟随系统','System')}</option><option value="zh">中文</option><option value="en">English</option></select></Row></Section><Section title="Agent"><Row icon={<Shield/>} title={t('权限与规则','Permissions & rules')} detail="permissions.json" onClick={() => nav('/settings/editor?file=permissions.json')}/></Section><ErrorNotice error={action.error}/></main>;
}
export function AppearancePage() {
  const {device, refresh} = useContext(Environment); const action = useAction(); const t = useText(); const [mask, setMask] = useState(device?.backgroundMask ?? 63);
  if (!device) return null;
  const change = (options: Parameters<typeof Device.setAppearance>[0]) => action.run(async () => { await Device.setAppearance(options); await refresh(); });
  return <main className="page"><Header title={t('外观','Appearance')}/><div className={`appearance-preview bg-${device.background}`}>
    {device.background === 'image' && device.backgroundPath && <img src={Capacitor.convertFileSrc(device.backgroundPath)} alt=""/>}<div className="appearance-mask" style={{opacity:mask/100}}/><div className="appearance-clock"><span>{new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span><small>{t('桌面预览','Home preview')}</small></div>
  </div><Section title={t('主题','Theme')}><div className="theme-options">{(['system','light','dark'] as const).map((theme,index) => <button key={theme} aria-pressed={device.theme === theme} onClick={() => change({theme})}><span className={`theme-sample ${theme}`}><i/><i/><i/></span>{[t('跟随系统','System'),t('浅色','Light'),t('深色','Dark')][index]}</button>)}</div></Section><Section title={t('背景','Background')}><Row title={t('背景类型','Background style')}><select aria-label={t('背景类型','Background style')} value={device.background} onChange={e => change({background:e.target.value as DeviceState['background']})}><option value="circles">{t('圆形','Circles')}</option><option value="solid">{t('纯色','Solid')}</option><option value="image">{t('图片','Image')}</option></select></Row><Row title={t('选择图片','Choose image')} onClick={() => action.run(async () => { await Device.chooseBackground(); await refresh(); })}/>{device.backgroundPath && <Row title={t('清除图片','Clear image')} onClick={() => action.run(async () => { await Device.clearBackground(); await refresh(); })}/>}<label className="range-row"><span>{t('遮罩强度','Mask opacity')}<output>{mask}%</output></span><input aria-label={t('遮罩强度','Mask opacity')} type="range" min="20" max="100" value={mask} onChange={e => setMask(Number(e.target.value))} onPointerUp={() => change({backgroundMask:mask})} onKeyUp={() => change({backgroundMask:mask})}/></label></Section><ErrorNotice error={action.error}/></main>;
}
export function DevicePage() {
  const {device, refresh} = useContext(Environment); const action = useAction(); const t = useText(); if (!device) return null;
  const perform = (fn:() => Promise<unknown>) => action.run(async () => { await fn(); await refresh(); });
  return <main className="page"><Header title={t('桌面与手势','Home & gestures')}/><Section title={t('设备状态','Device status')}>{[[t('默认桌面','Default home'),device.homeRole],[t('安全设置权限','Secure settings permission'),device.canWriteSecureSettings],[t('无障碍服务','Accessibility service'),device.accessibilityConnected]].map(([label,ready]) => <Row key={String(label)} title={String(label)}><span className={ready ? 'success' : 'secondary'}>{ready ? t('已就绪','Ready') : t('未启用','Not enabled')}</span></Row>)}</Section><Section title={t('桌面','Home')}><Row title={t('设为默认桌面','Set as default home')} onClick={() => perform(Device.requestHome)}/><Row title={t('系统默认应用设置','System default apps')} onClick={() => perform(() => Device.openSystemSettings({target:'home'}))}/></Section><Section title={t('手势','Gestures')}><p className="secondary pre-wrap">{device.gestureStatus}</p><div className="action-row"><button className="button" onClick={() => perform(Device.enableGestures)}>{t('启用手势','Enable gestures')}</button><button className="button secondary-button" onClick={() => perform(Device.disableGestures)}>{t('停用','Disable')}</button></div><Row title={t('修复 Shizuku 权限','Repair Shizuku permissions')} onClick={() => perform(Device.repairPermissions)}/><Row title={t('无障碍设置','Accessibility settings')} onClick={() => perform(() => Device.openSystemSettings({target:'accessibility'}))}/><Row title={t('应用系统设置','App settings')} onClick={() => perform(() => Device.openSystemSettings({target:'app'}))}/></Section><ErrorNotice error={action.error}/></main>;
}
export function AboutPage() {
  const t = useText(); const action = useAction(); const [version,setVersion] = useState(''); const [release,setRelease] = useState<Record<string,unknown>|null>();
  useEffect(() => { void action.run(async () => setVersion((await CapacitorApp.getInfo()).version)); }, []);
  return <main className="page"><Header title={t('关于','About')}/><div className="about-heading"><span className="empty-mark">Pi</span><h2>E Launcher</h2><p>{version}</p><p className="secondary">{t('你的桌面，也是对话的起点。','Your home. A place to start a conversation.')}</p></div><Section title={t('项目','Project')}><Row icon={<ExternalLink/>} title={t('源代码与反馈','Source & feedback')} onClick={() => action.run(() => Device.openUrl({url:'https://github.com/FireSpoonYZ/e-launcher'}))}/><Row icon={<ExternalLink/>} title={t('Pi 文档','Pi documentation')} onClick={() => action.run(() => Device.openUrl({url:'https://github.com/badlogic/pi-mono'}))}/><Row icon={<RefreshCw/>} title={t('检查更新','Check for updates')} onClick={() => action.run(async () => setRelease((await NativeSettings.latestRelease()).release))}/></Section>{release === null && <p className="secondary">{t('暂无公开发布版本。','No public release yet.')}</p>}{release && <Row title={String(release.tag_name)} detail={String(release.name ?? '')} onClick={() => action.run(() => Device.openUrl({url:String(release.html_url)}))}/>}<ErrorNotice error={action.error}/></main>;
}
const engines: Array<VoiceState['sttEngine']> = ['system','remote'];
const speakModes: Array<VoiceState['speakMode']> = ['off','afterVoice','always'];
const sensitivities: Array<VoiceState['wakeSensitivity']> = ['low','medium','high'];
const rates = [0.75, 1, 1.25, 1.5, 2];
export function VoicePage() {
  const t = useText(); const action = useAction();
  const [voice, setVoice] = useState<VoiceState>(); const [remote, setRemote] = useState<'stt'|'tts'>();
  const [wake, setWake] = useState<string>(); const [assistant, setAssistant] = useState(false); const [message, setMessage] = useState('');
  const reload = () => action.run(async () => setVoice(await Device.voiceSettings()));
  useEffect(() => {
    void reload();
    const onVisible = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  const apply = (options: Parameters<typeof Device.setVoiceSettings>[0]) => action.run(async () => setVoice(await Device.setVoiceSettings(options)));
  // Shizuku applies the role asynchronously; poll until the system reports it.
  const claimAssistant = () => action.run(async () => {
    await Device.requestAssistantRole();
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const state = await Device.voiceSettings();
      setVoice(state);
      if (state.assistantDefault) return;
    }
  });
  if (!voice) return <main className="page"><Header title={t('语音','Voice')}/><ErrorNotice error={action.error}/></main>;
  const engineLabels = [t('系统内置','Built-in'), t('远程模型（OpenAI 兼容）','Remote model (OpenAI compatible)')];
  const remoteDetail = (value: VoiceRemote) => value.baseUrl ? `${value.model} · ${value.baseUrl}${value.configured ? ` · ${t('已保存 API Key','API key saved')}` : ''}` : t('未配置','Not configured');
  const wakeDetail = !voice.wakeEnabled ? t('已关闭','Off') : voice.wakeStatus
    || (voice.wakeListening ? (voice.assistantDefault ? t('正在监听（默认助手，由系统保持运行）','Listening (default assistant)') : t('正在监听（前台服务）','Listening (foreground service)'))
      : t('已开启，回到桌面后开始监听','On; listening starts on the home screen'));
  return <main className="page"><Header title={t('语音','Voice')}/>
    <Section title={t('语音识别','Speech recognition')}>
      <Row title={t('识别引擎','Recognition engine')}><select aria-label={t('识别引擎','Recognition engine')} value={voice.sttEngine} onChange={e => apply({sttEngine: e.target.value as VoiceState['sttEngine']})}>{engines.map((engine,index) => <option key={engine} value={engine}>{engineLabels[index]}</option>)}</select></Row>
      {voice.sttEngine === 'remote' && <Row title={t('远程识别模型','Remote recognition model')} detail={remoteDetail(voice.stt)} onClick={() => setRemote('stt')}/>}
      <Row title={t('测试语音识别','Test recognition')} onClick={() => action.run(async () => setMessage(`${t('识别结果：','Recognized: ')}${(await Device.listenOnce()).text}`))}/>
      {message && <p className="secondary" role="status">{message}</p>}
    </Section>
    <Section title={t('语音朗读','Read aloud')}>
      <Row title={t('朗读引擎','Speech engine')}><select aria-label={t('朗读引擎','Speech engine')} value={voice.ttsEngine} onChange={e => apply({ttsEngine: e.target.value as VoiceState['ttsEngine']})}>{engines.map((engine,index) => <option key={engine} value={engine}>{engineLabels[index]}</option>)}</select></Row>
      {voice.ttsEngine === 'remote'
        ? <Row title={t('远程朗读模型','Remote speech model')} detail={remoteDetail(voice.tts)} onClick={() => setRemote('tts')}/>
        : <Row title={t('系统朗读引擎设置','System speech engine settings')} onClick={() => action.run(() => Device.openSystemSettings({target:'tts'}))}/>}
      <Row title={t('语速','Speech rate')}><select aria-label={t('语速','Speech rate')} value={String(voice.speechRate)} onChange={e => apply({speechRate: Number(e.target.value)})}>{rates.map(rate => <option key={rate} value={String(rate)}>{rate}×</option>)}</select></Row>
      <Row title={t('自动朗读回复','Read replies aloud')}><select aria-label={t('自动朗读回复','Read replies aloud')} value={voice.speakMode} onChange={e => apply({speakMode: e.target.value as VoiceState['speakMode']})}>{speakModes.map((mode,index) => <option key={mode} value={mode}>{[t('关闭','Off'),t('语音输入后朗读','After voice input'),t('总是朗读当前会话','Always in the open chat')][index]}</option>)}</select></Row>
      <div className="action-row"><button className="button" onClick={() => action.run(() => Device.speak({text: t('你好，我是你的桌面助手。这是一段朗读测试。','Hello, this is a read-aloud test.')}))}>{t('试听朗读','Play sample')}</button><button className="button secondary-button" onClick={() => action.run(() => Device.stopSpeaking())}>{t('停止朗读','Stop')}</button></div>
    </Section>
    <Section title={t('语音唤醒','Wake word')}>
      <Row title={t('语音唤醒','Wake word')} detail={wakeDetail}><Toggle label={t('语音唤醒','Wake word')} checked={voice.wakeEnabled} onChange={enabled => action.run(async () => setVoice(await Device.setWakeEnabled({enabled})))}/></Row>
      <Row title={t('唤醒词','Wake words')} detail={voice.wakeWordsDetail} onClick={() => setWake(voice.wakeWords)}/>
      <Row title={t('唤醒灵敏度','Sensitivity')}><select aria-label={t('唤醒灵敏度','Sensitivity')} value={voice.wakeSensitivity} onChange={e => apply({wakeSensitivity: e.target.value as VoiceState['wakeSensitivity']})}>{sensitivities.map((value,index) => <option key={value} value={value}>{[t('低（更少误唤醒）','Low (fewer false wakes)'),t('中','Medium'),t('高（更容易唤醒）','High (easier to wake)')][index]}</option>)}</select></Row>
      <Row title={t('默认数字助理','Default digital assistant')} detail={voice.assistantDefault ? t('已是默认助手：无常驻通知，可在任意界面唤醒','Default assistant: no ongoing notification, wakes anywhere') : t('未设置：唤醒依靠带常驻通知的前台服务','Not set: wake relies on a foreground service with an ongoing notification')} onClick={() => setAssistant(true)}/>
      <p className="secondary">{t('唤醒在本机离线识别，不上传音频。开启后麦克风指示灯常亮并增加耗电；通话或其他应用录音时暂时无法唤醒。唤醒后说出请求，停顿后自动发送给助手。','Wake detection runs offline on this device. While it is on the microphone indicator stays lit and battery use rises; other apps recording audio pause detection.')}</p>
    </Section>
    <Section title={t('通用','General')}>
      <Row title={t('识别与朗读语言','Recognition & speech language')} detail={t('BCP-47 代码，留空跟随系统','BCP-47 tag; empty follows the system')}><input aria-label={t('识别与朗读语言','Recognition & speech language')} placeholder="zh-CN" defaultValue={voice.language} onBlur={e => apply({language: e.target.value})}/></Row>
    </Section>
    <ErrorNotice error={action.error}/>
    {remote && <RemoteVoiceForm kind={remote} remote={remote === 'stt' ? voice.stt : voice.tts} close={() => setRemote(undefined)} saved={setVoice}/>}
    <Dialog open={wake !== undefined} title={t('唤醒词','Wake words')} onOpenChange={value => !value && setWake(undefined)}>
      <form className="form" onSubmit={e => { e.preventDefault(); void action.run(async () => { setVoice(await Device.setVoiceSettings({wakeWords: wake!})); setWake(undefined); }); }}>
        <p className="secondary">{t('填写 2–8 个汉字，多个唤醒词用逗号分隔。多音字读错时可直接填拼音记号，例如：n ǐ h ǎo x iǎo y ì。四个字左右、音节差异大的词误唤醒更少。','2–8 syllables per word, separated by commas. Pinyin marks such as "n ǐ h ǎo x iǎo y ì" are accepted.')}</p>
        <label>{t('唤醒词','Wake words')}<input required value={wake ?? ''} onChange={e => setWake(e.target.value)}/></label>
        <ErrorNotice error={action.error}/><button className="button full" disabled={action.busy}>{t('保存','Save')}</button>
      </form>
    </Dialog>
    <Dialog open={assistant} title={t('默认数字助理','Default digital assistant')} onOpenChange={value => !value && setAssistant(false)}>
      <p className="secondary">{t('设为默认助手会替换当前的助手（如 Google 助理或小爱同学），系统语音识别会经由本应用转发给原识别服务。','Becoming the default assistant replaces the current one; system speech recognition is forwarded to the original recognizer.')}</p>
      <Row title={t('通过 Shizuku 设为默认助手','Set as default assistant via Shizuku')} onClick={() => { setAssistant(false); void claimAssistant(); }}/>
      <Row title={t('打开系统默认应用设置','Open system default apps settings')} onClick={() => { setAssistant(false); void action.run(() => Device.openSystemSettings({target:'assistant'})); }}/>
    </Dialog>
  </main>;
}
function RemoteVoiceForm({kind, remote, close, saved}: {kind: 'stt'|'tts'; remote: VoiceRemote; close(): void; saved(state: VoiceState): void}) {
  const t = useText(); const action = useAction();
  const [url, setUrl] = useState(remote.baseUrl); const [model, setModel] = useState(remote.model);
  const [voice, setVoice] = useState(remote.voice); const [key, setKey] = useState('');
  const save = (apiKey?: string) => action.run(async () => { saved(await Device.setVoiceRemote({kind, baseUrl: url, model, voice, apiKey: apiKey ?? (url !== remote.baseUrl ? '' : undefined)})); close(); });
  return <Dialog open title={kind === 'tts' ? t('远程朗读模型','Remote speech model') : t('远程识别模型','Remote recognition model')} onOpenChange={value => !value && close()}>
    <form className="form" onSubmit={e => { e.preventDefault(); void save(key.trim() ? key : undefined); }}>
      <p className="secondary">{kind === 'tts'
        ? t('OpenAI 兼容接口，朗读调用 {地址}/audio/speech。地址须为 https。API Key 仅保存在本机，不会显示或导出。','OpenAI-compatible endpoint: {base}/audio/speech. The base URL must be https; the API key stays on this device.')
        : t('OpenAI 兼容接口，识别调用 {地址}/audio/transcriptions。地址须为 https。API Key 仅保存在本机，不会显示或导出。','OpenAI-compatible endpoint: {base}/audio/transcriptions. The base URL must be https; the API key stays on this device.')}</p>
      {kind === 'tts' && <button type="button" className="button secondary-button" onClick={() => { setUrl('https://kokoro.firespoon.cn:3000/v1'); setModel('kokoro'); setVoice('zf_xiaoxiao'); setKey(''); }}>{t('使用自部署 Kokoro（需填写独立 API Key）','Use self-hosted Kokoro (separate API key required)')}</button>}
      <label>{t('接口地址','Base URL')}<input inputMode="url" placeholder="https://api.openai.com/v1" value={url} onChange={e => setUrl(e.target.value)}/></label>
      <label>API Key<input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder={remote.configured ? t('已保存，留空保持不变','Saved; leave blank to keep') : t('可选','Optional')}/></label>
      <label>{t('模型','Model')}<input value={model} onChange={e => setModel(e.target.value)}/></label>
      {kind === 'tts' && <label>{t('音色（voice）','Voice')}{model.toLowerCase() === 'kokoro' ? <select value={voice} onChange={e => setVoice(e.target.value)}>{!['zf_xiaobei','zf_xiaoni','zf_xiaoxiao','zf_xiaoyi','zm_yunjian','zm_yunxi','zm_yunxia','zm_yunyang'].includes(voice) && <option value={voice}>{voice || t('服务默认','Server default')}</option>}{['zf_xiaobei','zf_xiaoni','zf_xiaoxiao','zf_xiaoyi','zm_yunjian','zm_yunxi','zm_yunxia','zm_yunyang'].map(id => <option key={id} value={id}>{id}</option>)}</select> : <input value={voice} onChange={e => setVoice(e.target.value)}/>}</label>}
      <ErrorNotice error={action.error}/>
      <div className="dialog-actions"><button type="button" className="button secondary-button" disabled={action.busy || !remote.configured} onClick={() => void save('')}>{t('清除 API Key','Remove API key')}</button><button className="button" disabled={action.busy}>{t('保存','Save')}</button></div>
    </form>
  </Dialog>;
}
