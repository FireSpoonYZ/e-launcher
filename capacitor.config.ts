import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.launcherprobe',
  appName: 'Launcher Probe',
  webDir: 'web/dist',
  android: { path: '.' },
};

export default config;
