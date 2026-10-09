import { Capacitor } from '@capacitor/core';
import { RemoteTerminal } from './native.ts';
export async function readTerminalClipboard(): Promise<string> {
  return Capacitor.isNativePlatform() ? (await RemoteTerminal.readClipboard()).text : navigator.clipboard.readText();
}
export async function writeTerminalClipboard(text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) await RemoteTerminal.writeClipboard({text});
  else await navigator.clipboard.writeText(text);
}
