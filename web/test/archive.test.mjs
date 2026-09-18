import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHIVE_TTL_MS, archiveDeadline, archiveRemainingMs, archiveRemainingParts, isArchived } from '../src/archive.ts';

test('unarchived timestamps stay inactive and have no remaining time', () => {
  assert.equal(isArchived(undefined), false);
  assert.equal(isArchived(null), false);
  assert.equal(isArchived(0), false);
  assert.equal(archiveRemainingMs(0, 1), 0);
});

test('remaining time is 14×24h from this archive and restarts from a later archivedAt', () => {
  const now = 1_700_000_000_000;
  assert.equal(ARCHIVE_TTL_MS, 14 * 24 * 60 * 60 * 1000);
  assert.equal(isArchived(now), true);
  assert.equal(archiveDeadline(now), now + ARCHIVE_TTL_MS);
  assert.equal(archiveRemainingMs(now, now), ARCHIVE_TTL_MS);
  assert.equal(archiveRemainingMs(now, now + ARCHIVE_TTL_MS), 0);
  assert.equal(archiveRemainingMs(now, now + ARCHIVE_TTL_MS + 1), 0);
  const first = archiveRemainingParts(now, now + (13 * 24 + 2) * 60 * 60 * 1000);
  assert.equal(first.days, 0);
  assert.equal(first.hours, 22);
  const restarted = now + 60_000;
  assert.equal(archiveRemainingMs(restarted, now + 60_000), ARCHIVE_TTL_MS);
  assert.ok(archiveRemainingMs(restarted, now + 60_000) > archiveRemainingMs(now, now + 60_000));
});
