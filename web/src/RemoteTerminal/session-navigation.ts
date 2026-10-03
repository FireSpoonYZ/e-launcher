/** Read-only list loading is independent of the active terminal stream. */
export function createSessionListLoader<T>(load: () => Promise<T>, receive: (value: T) => void, failed: () => void) {
  let generation = 0, disposed = false;
  return {
    async refresh() {
      const attempt = ++generation;
      try { const value = await load(); if (!disposed && generation === attempt) receive(value); }
      catch { if (!disposed && generation === attempt) failed(); }
    },
    dispose() { disposed = true; generation++; },
  };
}
export function terminalDraftNeedsGuard(state: {composing: boolean; uncertain: boolean; rejected: boolean; queuedBytes: number; pending: boolean; value: string; sentText: string}) {
  return state.composing || state.uncertain || state.rejected || state.queuedBytes > 0 || state.pending || state.value !== state.sentText;
}
