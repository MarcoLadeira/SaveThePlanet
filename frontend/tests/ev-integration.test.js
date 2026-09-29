const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
test('EV comparison is optional and Rewards page remains available', () => {
  const index = read('index.html');
  const charging = read('charging.js');
  const comparison = read('ev.js');
  assert.ok(index.includes('charging.js') && index.includes('ev.js'));
  assert.ok(index.indexOf('charging.js') < index.indexOf('ev.js'));
  assert.ok(charging.includes('dwCard()'), 'Rewards must remain on existing EV page');
  assert.ok(charging.includes('renderEvComparison()'), 'comparison must be selectable');
  assert.ok(comparison.includes('renderEvComparison()'));
  assert.ok(!comparison.includes('function renderCharging()'), 'must not silently override the Rewards page');
  assert.ok(comparison.includes('data-ev-mode="current"') && comparison.includes('data-ev-mode="comparison"'));
});
