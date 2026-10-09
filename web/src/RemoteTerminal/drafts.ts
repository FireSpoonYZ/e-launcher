import { LiveInput } from './input.ts';
export type TerminalComposerDraft = { value:string; mirror:LiveInput; rejected:boolean };
export type TerminalDraft = { live:TerminalComposerDraft; bufferedDraft:TerminalComposerDraft; buffered:boolean };
const drafts = new Map<string, TerminalDraft>();
const leases = new Map<string, symbol>();
// A per-handle lease prevents an old page cleanup/restoration from overwriting a
// newly mounted session. Mirrors retain ambiguous delivery, never auto-replay.
export function claimTerminalDraft(handle: string) {
  const token = Symbol(handle); leases.set(handle,token);
  const draft = drafts.get(handle);
  return { draft, save(value:TerminalDraft) {
    if (leases.get(handle) !== token) return;
    drafts.set(handle,value);
  } };
}
