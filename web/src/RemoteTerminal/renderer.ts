import type { Terminal, IDisposable } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';

// Orca: mobile/src/terminal/document/webgl-recovery.ts
// @ de8bffe24045b396212f4f63de8960ec8380ea07. MIT Lovecast Inc.; see LICENSE.orca.
// Like Orca's mobile recovery: DOM fallback and one delayed GPU retry,
// without its document runtime. Call after open; dispose before the terminal.
export function attachTerminalRenderer(term: Terminal, createAddon: () => WebglAddon, applyTheme: () => void = () => {}, visibility: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | undefined = globalThis.document): IDisposable & { resume(): void } {
  let stopped = false;
  let active: { addon: WebglAddon; listener?: IDisposable } | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    try { term.refresh(0, Math.max(0, term.rows - 1)); } catch {}
  };
  const detach = () => {
    const previous = active;
    active = undefined;
    // Addon disposal restores xterm's DOM renderer even after context loss.
    try { previous?.listener?.dispose(); } catch {}
    try { previous?.addon.dispose(); } catch {}
  };
  const attach = (allowRecovery: boolean) => {
    if (stopped) return;
    try {
      const addon = createAddon();
      active = { addon };
      active.listener = addon.onContextLoss(() => {
        if (stopped || active?.addon !== addon) return;
        detach();
        refresh();
        if (allowRecovery) {
          // A second loss stays on DOM, never entering a GPU crash loop.
          recoveryTimer = setTimeout(() => {
            recoveryTimer = undefined;
            attach(false);
          }, 100);
        }
      });
      term.loadAddon(addon);
      if (!allowRecovery) refresh();
    } catch {
      // WebGL2 may be unavailable; keep the opened DOM terminal usable.
      detach();
      refresh();
    }
  };
  const resume = () => {
    if (stopped) return;
    applyTheme();
    try { active?.addon.clearTextureAtlas(); } catch {}
    refresh();
  };
  const visible = () => { if (visibility?.visibilityState === 'visible') resume(); };
  visibility?.addEventListener('visibilitychange', visible);
  attach(true);
  return {
    resume,
    dispose() {
      if (stopped) return;
      stopped = true;
      visibility?.removeEventListener('visibilitychange', visible);
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
      detach();
    },
  };
}
