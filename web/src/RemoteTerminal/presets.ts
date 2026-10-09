// Adapted from Orca src/shared/terminal-quick-commands.ts @ de8bffe24045b396212f4f63de8960ec8380ea07.
// MIT Copyright (c) 2026 Lovecast Inc. See LICENSE.orca.
// Keeps bounded normalization/upsert/delete; removes repo/agent launch graph; adds generic key chords.
import { buildTerminalShortcutKey, type TerminalShortcutBinding } from './orca/terminal-accessory-keys.ts';
import { encodeKey, encodeText, type InputModes } from './input.ts';
export type Preset = { id: string; label: string } & ({ kind: 'text'; text: string; appendEnter: boolean } | { kind: 'chord'; chord: TerminalShortcutBinding });
export const PRESET_STORAGE_KEY = 'remote-terminal.shortcuts.v1';
export const DEFAULT_PRESETS: Preset[] = [];
// Keep bindings editable even when only an enhanced keyboard protocol can encode them.
export function describeShortcut(binding: TerminalShortcutBinding): {label:string;accessibilityLabel:string} | null {
  if (!binding || typeof binding.key !== 'string' || !Array.isArray(binding.modifiers) || !binding.modifiers.every(m => typeof m === 'string' && ['ctrl','alt','shift'].includes(m))) return null;
  const base = buildTerminalShortcutKey({key:binding.key,modifiers:[]});
  if (!base) return null;
  const modifiers = (['ctrl','alt','shift'] as const).filter(m => binding.modifiers.includes(m)).map(m => m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : 'Shift');
  const label = [...modifiers,base.label].join('+');
  return {label,accessibilityLabel:[...modifiers,base.accessibilityLabel].join(' ')};
}
export function normalizePresets(input: unknown): Preset[] {
  if (!Array.isArray(input)) throw new Error('Invalid shortcut list');
  const normalized: Preset[] = [];
  const seenIds = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.label !== 'string') throw new Error('Invalid shortcut');
    const id = item.id.trim().slice(0, 80);
    if (!id || seenIds.has(id)) throw new Error('Duplicate shortcut ID');
    seenIds.add(id);
    const base = { id, label: item.label.slice(0, 80) };
    if (item.kind === 'text' && typeof item.text === 'string' && typeof item.appendEnter === 'boolean') {
      normalized.push({ ...base, kind: 'text', text: item.text.slice(0, 4000), appendEnter: item.appendEnter });
    } else if (item.kind === 'chord' && item.chord && typeof item.chord.key === 'string' && Array.isArray(item.chord.modifiers) && item.chord.modifiers.every((m: unknown) => typeof m === 'string' && ['ctrl','alt','shift'].includes(m)) && describeShortcut(item.chord)) {
      normalized.push({ ...base, kind: 'chord', chord: { key: /^[A-Z]$/.test(item.chord.key) ? item.chord.key.toLowerCase() : item.chord.key, modifiers: (['ctrl','alt','shift'] as const).filter(m => item.chord.modifiers.includes(m)) } });
    } else throw new Error('Invalid shortcut body');
    if (normalized.length > 40) throw new Error('At most 40 shortcuts');
  }
  return normalized;
}
export function mutatePreset(commands: readonly Preset[], mutation: { type: 'delete'; id: string } | { type: 'upsert'; command: Preset }): Preset[] {
  if (mutation.type === 'delete') return commands.filter(command => command.id !== mutation.id);
  const existingIndex = commands.findIndex(command => command.id === mutation.command.id);
  return normalizePresets(existingIndex === -1 ? [...commands, mutation.command] : commands.map((command, index) => index === existingIndex ? mutation.command : command));
}
export function presetInput(preset: Preset, modes: InputModes): string {
  return preset.kind === 'chord' ? encodeKey(preset.chord, modes) : encodeText(preset.text, modes) + (preset.appendEnter ? encodeKey({key:'enter',modifiers:[]}, modes) : '');
}
export function loadPresets(storage: Pick<Storage, 'getItem'>): Preset[] {
  const saved = storage.getItem(PRESET_STORAGE_KEY);
  return saved === null ? structuredClone(DEFAULT_PRESETS) : normalizePresets(JSON.parse(saved));
}
export function savePresets(storage: Pick<Storage, 'setItem'>, presets: Preset[]): void {
  storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(normalizePresets(presets)));
}
