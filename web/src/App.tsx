import { useEffect, useState } from 'react';
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Device, type DeviceState } from './native';
import { Environment, useBack } from './ui';
import { ArchivedPage, ChatPage, HistoryPage } from './Chat';
import { SettingsHome, GeneralPage, AppearancePage, DevicePage, AboutPage } from './Settings';
import { ProvidersPage, ResourcesPage } from './Resources';
import { AdvancedPage, EditorPage } from './Editor';
import { SchedulesPage, ScheduleHistoryPage } from './Schedules';

declare global {
  interface Window { PagerGesture?: {gestureId(): number; setBlocked(id: number, blocked: boolean): void}; }
}

function Navigation() {
  const back = useBack(); const location = useLocation();
  useEffect(() => {
    const gestureTarget = 'textarea,input,select,[contenteditable],[role="dialog"],.composer-popover,.attachment-popover';
    const blockPager = (event: TouchEvent) => {
      const bridge = window.PagerGesture;
      if (!bridge) return;
      const target = event.target instanceof Element ? event.target : null;
      const horizontal = target?.closest('pre,.table-scroll,.katex-display,.attachments,.todo-scroll');
      const scrollsHorizontally = !!horizontal && horizontal.scrollWidth > horizontal.clientWidth;
      bridge.setBlocked(bridge.gestureId(), event.touches.length !== 1
        || !!target?.closest(gestureTarget) || scrollsHorizontally || !!window.getSelection()?.toString()
        || !!document.querySelector('[role="dialog"],.attachment-popover')
        || !window.location.hash.startsWith('#/chat'));
    };
    const selectionChanged = () => {
      const bridge = window.PagerGesture;
      if (bridge && window.getSelection()?.toString()) bridge.setBlocked(bridge.gestureId(), true);
    };
    document.addEventListener('touchstart', blockPager, true);
    document.addEventListener('selectionchange', selectionChanged);
    return () => {
      document.removeEventListener('touchstart', blockPager, true);
      document.removeEventListener('selectionchange', selectionChanged);
    };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    let keyboardVisible = window.screen.height - (viewport?.height ?? window.innerHeight) > 140;
    let keyboardClosedAt = -Infinity;
    const resized = () => {
      const visible = window.screen.height - (viewport?.height ?? window.innerHeight) > 140;
      if (keyboardVisible && !visible) keyboardClosedAt = performance.now();
      keyboardVisible = visible;
    };
    viewport?.addEventListener('resize', resized);
    const listener = CapacitorApp.addListener('backButton', () => {
      if (keyboardVisible || performance.now() - keyboardClosedAt < 350) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        void Device.hideKeyboard(); return;
      }
      if (!window.dispatchEvent(new Event('composer-back', {cancelable:true}))) return;
      if (document.querySelector('[role="dialog"]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return;
      }
      const request = new Event('app-back', {cancelable: true});
      if (window.dispatchEvent(request)) back();
    });
    return () => { viewport?.removeEventListener('resize', resized); void listener.then(handle => handle.remove()); };
  }, [location.key]);
  return null;
}
function Shell({initialDevice}: {initialDevice: DeviceState}) {
  const [device, setDevice] = useState(initialDevice);
  const refresh = async () => { setDevice(await Device.state()); };
  useEffect(() => {
    let live = true;
    const listener = Device.addListener('deviceEvent', state => { if (live) setDevice(state); });
    return () => { live = false; void listener.then(h => h.remove()); };
  }, []);
  useEffect(() => {
    if (!device) return;
    document.documentElement.dataset.theme = device.theme;
    document.documentElement.lang = device.language === 'system' ? navigator.language : device.language;
    const system = matchMedia('(prefers-color-scheme: dark)');
    const applyBars = () => {
      const dark = device.theme === 'dark' || (device.theme === 'system' && system.matches);
      void SystemBars.setStyle({style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light});
    };
    applyBars(); system.addEventListener('change', applyBars);
    return () => system.removeEventListener('change', applyBars);
  }, [device]);
  // Android's WebView resizes for the IME; visualViewport also handles floating/pan keyboards.
  useEffect(() => {
    const resize = () => {
      document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
    };
    resize(); window.visualViewport?.addEventListener('resize', resize);
    return () => window.visualViewport?.removeEventListener('resize', resize);
  }, []);
  return <Environment.Provider value={{device, refresh}}><Navigation/><Routes>
    <Route path="/chat/:conversationId?" element={<ChatPage/>}/>
    <Route path="/history/:conversationId" element={<HistoryPage/>}/>
    <Route path="/archived" element={<ArchivedPage/>}/>
    <Route path="/schedules" element={<SchedulesPage/>}/>
    <Route path="/schedules/history" element={<ScheduleHistoryPage/>}/>
    <Route path="/settings" element={<SettingsHome/>}/>
    <Route path="/settings/general" element={<GeneralPage/>}/>
    <Route path="/settings/appearance" element={<AppearancePage/>}/>
    <Route path="/settings/device" element={<DevicePage/>}/>
    <Route path="/settings/providers" element={<ProvidersPage/>}/>
    <Route path="/settings/resources/:kind" element={<ResourcesPage/>}/>
    <Route path="/settings/advanced" element={<AdvancedPage/>}/>
    <Route path="/settings/editor" element={<EditorPage/>}/>
    <Route path="/settings/about" element={<AboutPage/>}/>
    <Route path="*" element={<Navigate to="/chat" replace/>}/>
  </Routes></Environment.Provider>;
}
export default function App({initialDevice}: {initialDevice: DeviceState}) { return <HashRouter><Shell initialDevice={initialDevice}/></HashRouter>; }
