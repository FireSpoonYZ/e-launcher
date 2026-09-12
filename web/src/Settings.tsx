import { useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import * as Switch from '@radix-ui/react-switch';
import { Database, ExternalLink, Grid2X2, Hand, Info, Palette, Puzzle, RefreshCw, Settings, Share2, Shield, SlidersHorizontal } from 'lucide-react';
import { Device, NativeSettings, type DeviceState } from './native';
import { Environment, ErrorNotice, Header, Row, Section, useAction, useText } from './ui';

export function SettingsHome() {
  const t = useText(); const nav = useNavigate();
  return <main className="page settings-home"><Header title={t('设置','Settings')}/><Section title={t('偏好','Preferences')}>
    <Row icon={<Settings/>} title={t('通用','General')} detail={t('语言与权限规则','Language & permission rules')} onClick={() => nav('/settings/general')}/>
    <Row icon={<Palette/>} title={t('外观','Appearance')} detail={t('主题与背景','Theme & background')} onClick={() => nav('/settings/appearance')}/>
    <Row icon={<Hand/>} title={t('桌面与手势','Home & gestures')} detail={t('默认桌面与系统权限','Default home & permissions')} onClick={() => nav('/settings/device')}/>
  </Section><Section title={t('AI 与工具','AI & tools')}>
    <Row icon={<Database/>} title={t('服务商与模型','Providers & models')} onClick={() => nav('/settings/providers')}/>
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
