/** Read-only observations are deliberately separate from an opt-in provider request. */
export const READINESS_TTL = 60_000;
export type ModelReadiness = {
  provider: string; model: string; selectionConfigured: boolean;
  credentialSaved: boolean; revision: string;
};
export type DeviceCapabilities = {
  piInstalled: boolean; showerInstalled: boolean;
  shizukuInstalled: boolean; shizukuRunning: boolean;
  shizukuPermission: 'granted'|'notGranted'|'denied'|'unknown';
  showerDisplayActive: boolean;
};
export type ComputerReadiness = { paired: number; connected: number };
export type Observation<T> = { value?: T; checkedAt: number };
export type ReadinessSnapshot = {
  model: Observation<ModelReadiness>; device: Observation<DeviceCapabilities>;
  computer: Observation<ComputerReadiness>;
};
export type ProviderCheck = { revision: string; provider: string; model: string; checkedAt: number; passed: boolean };
export type Text = (zh: string, en: string) => string;

export function fresh(checkedAt: number, now: number) {
  return checkedAt > 0 && now >= checkedAt && now - checkedAt < READINESS_TTL;
}
export function modelTestState(model: ModelReadiness | undefined, check: ProviderCheck | undefined, now: number) {
  if (!check) return 'untested';
  if (!model || model.revision !== check.revision || model.provider !== check.provider || !fresh(check.checkedAt, now)) return 'stale';
  return check.passed ? (check.model === model.model ? 'passed' : 'otherModel') : 'failed';
}
export function phoneGuidance(device: DeviceCapabilities | undefined, t: Text) {
  if (!device) return t('无法读取状态，请刷新后重试。', 'Could not read status. Refresh to try again.');
  if (!device.shizukuInstalled) return t('先安装并启动官方 Shizuku，再回到助手权限页授权。', 'Install and start official Shizuku, then authorize this app in Assistant permissions.');
  if (!device.shizukuRunning) return t('打开 Shizuku 并启动服务；重启手机后可能需要重新启动。', 'Open Shizuku and start its service. A phone restart may require starting it again.');
  if (device.shizukuPermission === 'denied') return t('授权被拒绝。请在 Shizuku 管理器中允许本应用，再返回刷新。', 'Permission was denied. Allow this app in the Shizuku manager, then refresh.');
  if (device.shizukuPermission !== 'granted') return t('前往助手权限页，由你明确授予 Shizuku 权限。', 'Open Assistant permissions to explicitly grant Shizuku access.');
  if (!device.showerInstalled) return t('缺少 Shower 运行资源，请使用完整 APK 覆盖更新。', 'Shower runtime assets are missing. Update with a complete APK.');
  return t('已满足本地前提。虚拟屏按任务需要创建；授权不代表点击、输入已验证。', 'Local prerequisites are present. Displays are created on demand; permission does not verify taps or typing.');
}
export function computerGuidance(computer: ComputerReadiness | undefined, t: Text) {
  if (!computer) return t('无法读取电脑状态，请刷新；不会自动重新配对。', 'Could not read computer status. Refresh; pairing is never replaced automatically.');
  if (!computer.paired) return t('在电脑的 e-desktop「终端」生成一次性配对信息，再到远程终端添加。', 'Generate one-time pairing info in e-desktop’s Terminal window, then add it in Remote terminals.');
  if (!computer.connected) return t('配对已保存，当前没有已认证连接。确认 e-desktop 正在运行、手机可达局域网或 Tailscale 后打开远程终端。', 'Pairing is saved, but no authenticated connection is open. Check e-desktop and LAN or Tailscale reachability, then open Remote terminals.');
  return t('当前存在已认证连接。仍需在终端页检查会话；这里不发送命令或接管输入。', 'An authenticated connection is open. Check sessions in Remote terminals; this screen sends no commands or control input.');
}
export async function observe<T>(read: () => Promise<T>, timeoutMs = 8_000): Promise<Observation<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    return {value: await Promise.race([Promise.resolve().then(read), timeout]), checkedAt: Date.now()};
  } catch { return {checkedAt: Date.now()}; } // Native/provider errors may contain private config.
  finally { clearTimeout(timer); }
}
