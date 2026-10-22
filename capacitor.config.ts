import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.launcherprobe',
  appName: 'AI Assistant',
  webDir: 'web/dist',
  android: { path: '.' },
  // Do not log bridge payloads (plugin methodData may contain synthesized
  // credentials); framework-level bridge logging off, native paths stay.
  loggingBehavior: 'none',
};

export default config;
