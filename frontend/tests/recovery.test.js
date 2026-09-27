const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({
  n: String,
  pct: value => `${Math.round(value * 1000) / 10}%`,
  icon: () => '<svg aria-hidden="true"></svg>',
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dashboard.js'), 'utf8'), context);

test('full recovery uses the reference caption and actual energy values', () => {
  const html = context.dashboardRecoveryCard({ atRiskMwh: 0.35 }, { potentialRecoveryMwh: 0.35, remainingWasteMwh: 0 });
  assert.match(html, /All predicted at-risk energy can be recovered\./);
  assert.match(html, /<strong>0\.35<\/strong>/);
  assert.match(html, /<strong>100%<\/strong>/);
  assert.match(html, /stroke-dasharray="100 100"/);
});

test('partial recovery updates the ring, caption, remaining value and progress', () => {
  const html = context.dashboardRecoveryCard({ atRiskMwh: 0.8 }, { potentialRecoveryMwh: 0.5, remainingWasteMwh: 0.3 });
  assert.match(html, /62\.5% of at-risk energy could be recovered\./);
  assert.match(html, /<strong>0\.5<\/strong>/);
  assert.match(html, /<b>0\.3 MWh<\/b> remaining/);
  assert.match(html, /stroke-dasharray="62\.5 100"/);
  assert.match(html, /width:62\.5%/);
  assert.doesNotMatch(html, /All predicted/);
});

test('zero risk does not show a full recovery ring or a stray progress dot', () => {
  const html = context.dashboardRecoveryCard({ atRiskMwh: 0 }, { potentialRecoveryMwh: 0, remainingWasteMwh: 0 });
  assert.match(html, /No predicted at-risk energy for this window\./);
  assert.match(html, /<strong>0%<\/strong>/);
  assert.match(html, /stroke-opacity="0"/);
  assert.match(html, /width:0%/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
