/** Full 14×24h from this archive's archivedAt; re-archive restarts the clock. */
export const ARCHIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function isArchived(archivedAt?: number | null) {
  return (archivedAt ?? 0) > 0;
}

export function archiveDeadline(archivedAt: number) {
  return archivedAt + ARCHIVE_TTL_MS;
}

export function archiveRemainingMs(archivedAt: number, now = Date.now()) {
  if (!isArchived(archivedAt)) return 0;
  return Math.max(0, archiveDeadline(archivedAt) - now);
}

export function archiveRemainingParts(archivedAt: number, now = Date.now()) {
  const ms = archiveRemainingMs(archivedAt, now);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  return {ms, days: Math.floor(ms / day), hours: Math.floor((ms % day) / hour)};
}
