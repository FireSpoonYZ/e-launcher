import assert from 'node:assert/strict';
import test from 'node:test';
import { LatestRequest } from '../src/latestRequest.ts';

test('A to B to A defaults only accept the latest conversation request', () => {
  const gate = new LatestRequest();
  const firstA = gate.begin();
  gate.cancel(firstA);
  const b = gate.begin();
  gate.cancel(b);
  const secondA = gate.begin();

  assert.equal(gate.current(firstA), false);
  assert.equal(gate.current(b), false);
  assert.equal(gate.current(secondA), true);
});
