// Manually verify each full annual notice before running. This updates the APK snapshot, not a live service.
// node scripts/update-cn-holidays.mjs <40-character holiday-cn commit> <year...> --verified
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

const [commit, ...args] = process.argv.slice(2);
assert.match(commit ?? '', /^[a-f0-9]{40}$/);
assert.equal(args.pop(), '--verified', 'Verify the full State Council notices first; then pass --verified');
assert.ok(args.length > 0);
const years = args.map(Number);
assert.ok(years.every(year => Number.isInteger(year) && year >= 2007 && year <= 2100));
assert.equal(new Set(years).size, years.length);
const root = 'https://api.github.com/repos/NateScarlet/holiday-cn/contents/';
const get = async url => {
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  assert.ok(response.ok, url + ': ' + response.status);
  return response.json();
};
const entries = new Map();
const data = [];
for (const year of years.sort()) {
  const file = await get(root + year + '.json?ref=' + commit);
  const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  assert.equal(value.year, year);
  assert.ok(Array.isArray(value.papers) && value.papers.length > 0, 'Unpublished annual placeholder');
  assert.ok(value.papers.every(url => typeof url === 'string' && /^https:\/\/www\.gov\.cn\//.test(url)));
  assert.ok(Array.isArray(value.days) && value.days.length > 0, 'Missing annual arrangements');
  const seen = new Set();
  for (const day of value.days) {
    assert.equal(typeof day.isOffDay, 'boolean');
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(day.date + 'T00:00:00Z').toISOString().slice(0, 10), day.date);
    assert.ok(Math.abs(Number(day.date.slice(0, 4)) - year) <= 1, 'Date outside adjacent years');
    assert.ok(!seen.has(day.date), 'Duplicate date');
    seen.add(day.date);
    assert.ok(!entries.has(day.date) || entries.get(day.date) === day.isOffDay, 'Conflicting annual dates');
    entries.set(day.date, day.isOffDay);
  }
  data.push({year, papers: value.papers, days: value.days.map(({date, isOffDay}) => ({date, isOffDay}))});
}
const license = await get('https://api.github.com/repos/NateScarlet/holiday-cn/license?ref=' + commit);
assert.equal(license.license.spdx_id, 'MIT');
const assets = new URL('../app/src/main/assets/', import.meta.url);
await writeFile(new URL('cn-holidays.json', assets), JSON.stringify({sourceCommit: commit, years: data}, null, 2) + '\n');
await writeFile(new URL('cn-holidays-LICENSE.txt', assets), Buffer.from(license.content, 'base64'));
console.log('Verified snapshot: ' + years.join(', ') + ' at ' + commit);
