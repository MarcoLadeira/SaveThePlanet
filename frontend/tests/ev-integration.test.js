const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
test('EV page is one view: the charging plan comparison, with the Rewards card', () => {
  const index = read('index.html');
  const charging = read('charging.js');
  const comparison = read('ev.js');
  assert.ok(index.includes('charging.js') && index.includes('ev.js'));
  assert.ok(index.indexOf('charging.js') < index.indexOf('ev.js'));
  assert.ok(charging.includes('function dwCard()'), 'the Rewards card stays in charging.js');
  assert.ok(comparison.includes('dwCard()'), 'the EV page shows the Rewards card');
  assert.ok(charging.includes('return renderEvComparison();'), 'the EV page draws the comparison view');
  assert.ok(!comparison.includes('function renderCharging()'), 'charging.js keeps the page entry point');
  assert.ok(!comparison.includes('data-ev-mode') && !charging.includes('cgModeMenu'), 'no view switch');
});
