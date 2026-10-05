import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface Host { id: string; name: string; address: string; port: number; fingerprint: string }
export interface Session { id: string; title: string; profileId: string; cwd: string; cols: number; rows: number; status: 'running' | 'exited'; exitCode?: number; ownerClientId: string | null }
export interface Snapshot { ansi: string; cols: number; rows: number; seq: number; kittyKeyboardFlags?: number }
export interface Profile { id: string; name: string; executable: string; available: boolean; reason?: string }
export type TerminalEvent = { hostId: string } & (
  | { event: 'connection'; state: 'connected' | 'disconnected'; message?: string; code?: string }
  | { event: 'terminal.output'; sessionId: string; data: string; seq: number }
  | { event: 'terminal.snapshot'; sessionId: string; snapshot: Snapshot }
  | { event: 'terminal.control'; sessionId: string; ownerClientId: string | null }
  | { event: 'terminal.exit'; sessionId: string; exitCode: number }
  | { event: 'terminal.listChanged' }
);
interface RemoteTerminalPlugin {
  /** Reads saved hosts and authenticated sockets; never dials or decrypts tokens. */
  readiness(): Promise<{paired: number; connected: number}>;
  loadShortcuts(): Promise<{ value: string | null }>;
  saveShortcuts(options: { value: string | null }): Promise<void>;
  listHosts(): Promise<{ hosts: Host[] }>;
  pair(options: { descriptor: string; address?: string; deviceName?: string }): Promise<{ host: Host }>;
  removeHost(options: { hostId: string }): Promise<void>;
  connect(options: { hostId: string }): Promise<{ hostId: string; clientId: string }>;
  disconnect(options: { hostId: string }): Promise<void>;
  request(options: { hostId: string; method: string; params: Record<string, unknown> }): Promise<{ result: unknown }>;
  addListener(event: 'terminalEvent', callback: (event: TerminalEvent) => void): Promise<PluginListenerHandle>;
}
export const RemoteTerminal = registerPlugin<RemoteTerminalPlugin>('RemoteTerminal');
export async function request<T>(hostId: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await RemoteTerminal.request({ hostId, method, params })).result as T;
}
