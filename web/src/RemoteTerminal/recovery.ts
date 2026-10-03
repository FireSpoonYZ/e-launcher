// Read-only recovery: callers supply auth/read/subscribe, never terminal mutations.
export function recoveryErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}
export function recoveryStops(error: unknown): boolean {
  return ['UNAUTHORIZED','PIN_MISMATCH','CERTIFICATE_ERROR','CERTIFICATE_INVALID','NOT_FOUND','SESSION_NOT_FOUND','HOST_NOT_FOUND'].includes(recoveryErrorCode(error));
}
export function createRecovery(run: (current: () => boolean) => Promise<void>, failed: (error: unknown) => void) {
  let generation = 0, disposed = false, paused = false, blocked = false;
  let flight: Promise<void> | undefined, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = (): Promise<void> => {
    if (disposed || paused || blocked) return Promise.resolve();
    clearTimeout(timer);
    if (flight) return flight;
    const ticket = generation;
    const current = () => !disposed && !paused && ticket === generation;
    flight = Promise.resolve().then(() => run(current)).catch(error => {
      // A disconnect may invalidate a dial before its auth rejection arrives.
      // Do not lose a terminal rejection simply because that callback ran first.
      if (disposed || (!current() && (paused || !again) && !recoveryStops(error))) return;
      again = false;
      blocked = recoveryStops(error); failed(error);
      if (!blocked) timer = setTimeout(() => { void wake(); }, 2000);
    }).finally(() => {
      flight = undefined;
      if (again) { again = false; void wake(); }
    });
    return flight;
  };
  return {
    get blocked() { return blocked; },
    wake,
    invalidate() { generation++; again = !!flight; },
    pause() { paused = true; generation++; clearTimeout(timer); },
    resume() { const wasPaused = paused; paused = false; if (flight && wasPaused) again = true; return wake(); },
    stop(error: unknown) { blocked = true; generation++; again = false; clearTimeout(timer); if (!disposed) failed(error); },
    retry() { blocked = false; return wake(); },
    dispose() { disposed = true; generation++; clearTimeout(timer); },
  };
}
