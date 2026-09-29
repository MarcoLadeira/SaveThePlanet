const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pinnedTargetAfter, selectionChip } = require('../pinning.js');

const A = '2026-01-11T21:30:00Z';
const B = '2026-01-26T07:30:00Z';
const real = (target) => ({ dataMode: 'historical-prediction', pinnedTarget: target, stale: null });

test('A -> B -> outage -> recovery keeps one pinned target', () => {
  let pinned = null;
  pinned = pinnedTargetAfter(pinned, real(A));
  assert.equal(pinned, A);
  pinned = pinnedTargetAfter(null, real(B)); // "New target" clears the pin, then B arrives
  assert.equal(pinned, B);
  // Outage: the server keeps B's last real forecast (stale) ...
  pinned = pinnedTargetAfter(pinned, { ...real(B), stale: { since: '2026-09-27T20:00:00Z' } });
  assert.equal(pinned, B);
  // ... or, with nothing real, an offline example for another time: the pin must not move.
  pinned = pinnedTargetAfter(pinned, { dataMode: 'simulated', pinnedTarget: B, fallback: { requestedTarget: B } });
  assert.equal(pinned, B);
  pinned = pinnedTargetAfter(pinned, real(B)); // recovery
  assert.equal(pinned, B);
});

test('a stale forecast for another target can never replace the pin', () => {
  assert.equal(pinnedTargetAfter(A, { ...real(B), stale: { since: 'x' } }), A);
});

test('selection chips never claim energy when nothing reached the minimum', () => {
  const met = selectionChip({ mode: 'predicted', metThreshold: true, minPredictedMwh: 10, attempts: 3, band: 'likely' });
  assert.equal(met.tone, 'ok');
  assert.match(met.text, /Predicted ≥ 10 MWh · likely forecast/);
  const below = selectionChip({ mode: 'predicted', metThreshold: false, minPredictedMwh: 10, attempts: 10 });
  assert.equal(below.tone, 'warn');
  assert.match(below.text, /Nothing ≥ 10 MWh found/);
  assert.match(selectionChip({ mode: 'unfiltered' }).text, /Unfiltered/);
  assert.equal(selectionChip(null), null);
});

test('a curtailment day says the day came from the EirGrid record and the half-hour from predictions', () => {
  const chip = selectionChip({ mode: 'predicted', metThreshold: true, minPredictedMwh: 10, band: 'certain', day: '2026-01-11' });
  assert.equal(chip.text, 'Recorded curtailment day · half-hour predicted ≥ 10 MWh · certain forecast');
  assert.equal(selectionChip({ mode: 'predicted', metThreshold: false, minPredictedMwh: 10, day: '2026-01-11' }).text,
    'Recorded curtailment day · strongest predicted half-hour');
});
