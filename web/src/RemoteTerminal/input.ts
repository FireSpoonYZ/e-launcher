import { buildTerminalShortcutKey, type TerminalShortcutBinding, type TerminalShortcutModifier } from './orca/terminal-accessory-keys.ts';
import { KittyKeyboard } from './xterm/KittyKeyboard.ts';
import { computeTerminalLiveMirrorStep, buildTerminalLiveMirrorPayload } from './orca/terminal-live-preedit-mirror.ts';

import { encodeImeCommitForKitty } from './orca/terminal-ime-kitty-commit-encoding.ts';

export const TERMINAL_SEND_MAX_BYTES = 64 * 1024;
export const terminalInputByteLength = (data: string): number => new TextEncoder().encode(data).byteLength;
export const isTerminalSendWithinLimit = (data: string): boolean => terminalInputByteLength(data) <= TERMINAL_SEND_MAX_BYTES;
export type HardwareBinding = TerminalShortcutBinding & { code?: string; metaKey?: boolean };
const kitty = new KittyKeyboard();
export interface InputModes { applicationCursor: boolean; kittyFlags?: number; bracketedPaste: boolean }
const domKeys: Record<string, string> = { escape: 'Escape', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageUp: 'PageUp', pageDown: 'PageDown', arrowUp: 'ArrowUp', arrowDown: 'ArrowDown', arrowLeft: 'ArrowLeft', arrowRight: 'ArrowRight', space: ' ' };
export function encodeKey(binding: HardwareBinding, modes: InputModes, eventType = 1): string {
  const { key, modifiers } = binding;
  const domKey = domKeys[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key);
  if (modes.kittyFlags) {
    const result = kitty.evaluate({ key: domKey, code: binding.code ?? '', type: eventType === 3 ? 'keyup' : 'keydown', keyCode: 0,
      ctrlKey: modifiers.includes('ctrl'), altKey: modifiers.includes('alt'), shiftKey: modifiers.includes('shift'), metaKey: binding.metaKey ?? false }, modes.kittyFlags, eventType);
    if (result.key !== undefined) return result.key;
    if (eventType === 3) return '';
  }
  if (eventType === 3) return '';
  // Modified Enter is intentionally distinct from submit even outside Kitty mode.
  if (key === 'enter' && (modifiers.includes('shift') || modifiers.includes('ctrl'))) {
    return '\x1b[13;' + (1 + (modifiers.includes('shift') ? 1 : 0) + (modifiers.includes('alt') ? 2 : 0) + (modifiers.includes('ctrl') ? 4 : 0)) + 'u';
  }
  const bytes = buildTerminalShortcutKey(binding)?.bytes ?? (Array.from(key).length === 1 ? key : '');
  return modes.applicationCursor && modifiers.length === 0 && /^\x1b\[[ABCDHF]$/.test(bytes) ? bytes.replace('[', 'O') : bytes;
}
export function hardwareBinding(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey'> & Partial<Pick<KeyboardEvent, 'code' | 'metaKey'>>): HardwareBinding {
  const key = Object.keys(domKeys).find(key => domKeys[key] === event.key) ?? (/^F\d+$/.test(event.key) ? event.key.toLowerCase() : event.key);
  const modifiers: TerminalShortcutModifier[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');
  return { key, modifiers, code: event.code, metaKey: event.metaKey };
}
// Shared by the DOM handler and tests: event-reporting also needs physical printable presses.
export function hardwareKeyDown(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code' | 'isComposing' | 'keyCode' | 'repeat' | 'metaKey'>, modes: InputModes, sticky: TerminalShortcutModifier[]) {
  if (event.isComposing || event.keyCode === 229) return null;
  const binding = hardwareBinding(event);
  binding.modifiers = [...new Set([...binding.modifiers, ...sticky])];
  const printable = Array.from(event.key).length === 1;
  if (printable && !binding.modifiers.includes('ctrl') && !binding.modifiers.includes('alt') && !binding.metaKey && !sticky.length && !(modes.kittyFlags && ((modes.kittyFlags & 10) || binding.code?.startsWith('Numpad')))) return null;
  const eventType = event.repeat ? 2 : 1;
  return encodeKey(binding, modes, eventType) ? { binding, eventType } : null;
}
export function encodeText(text: string, modes: InputModes): string {
  return modes.kittyFlags && (modes.kittyFlags & 8)
    ? Array.from(text).map(key => encodeImeCommitForKitty({key, shiftKey:false}, modes.kittyFlags!, {committedText:key}).report ?? key).join('') : text;
}
export function encodePaste(text: string, modes: InputModes): string {
  const normalized = text.replace(/\r\n|\n/g, '\r');
  return modes.bracketedPaste ? '\x1b[200~' + normalized + '\x1b[201~' : encodeText(normalized, modes);
}
export interface LiveInputDelivery { cancelled(): void; uncertain(): void }
// DOM reports composition explicitly: no timer guesses whether Chinese preedit is committed.
export class LiveInput {
  sentText = '';
  composing = false;
  uncertain = false;
  private generation = 0;
  private resetGeneration = 0;
  change(text: string): string;
  change(text: string, accept: (payload: string, delivery: LiveInputDelivery) => boolean): string | null;
  change(text: string, accept: (payload: string, delivery: LiveInputDelivery) => boolean = () => true): string | null {
    // A rejected native request may already have reached the PTY. Only an explicit
    // local clear starts a new mirror; never resend this ambiguous draft.
    if (this.uncertain) {
      if (text) return null;
      this.reset(); return '';
    }
    const generation = this.generation, resetGeneration = this.resetGeneration, before = this.sentText;
    const step = computeTerminalLiveMirrorStep(this.sentText, text, { commitHeld: false, composing: this.composing });
    const payload = buildTerminalLiveMirrorPayload(step);
    if (payload && !accept(payload, {
      cancelled: () => {
        // The first locally cancelled delta owns the rollback. Later queued
        // deltas must not advance the baseline over that missing prefix again.
        if (generation !== this.generation) return;
        this.sentText = before; this.generation++;
      },
      uncertain: () => {
        // Cancelling an undispatched suffix does not settle the dispatched prefix.
        // Only an explicit mirror reset can retire its delivery-unknown callback.
        if (resetGeneration !== this.resetGeneration) return;
        this.uncertain = true; this.generation++;
      },
    })) return null;
    this.sentText = step.nextSentText;
    return payload;
  }
  reset() { this.generation++; this.resetGeneration++; this.sentText = ''; this.composing = false; this.uncertain = false; }
}
