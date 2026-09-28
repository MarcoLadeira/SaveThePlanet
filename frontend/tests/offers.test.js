const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The EV page's discount-window card against the backend's real contract (the Impact fixture's offers).
const SECTION = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'business-impact.json'), 'utf8')).discountWindows;
const OFFERS = { status: 'ready', dataMode: 'simulated', hub: SECTION.hub, prices: SECTION.prices, offers: SECTION.offers, member: { joined: false, bookings: [] } };

function load() {
  const context = vm.createContext({
    document: { addEventListener() {} }, window: { addEventListener() {} },
    localStorage: { getItem: () => 'demo-test-member', setItem() {} },
    modelState: {}, pageFromHash: () => 'charging', render() {}, liveRender: false, queueMicrotask() {},
    n: (value) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value),
    escapeHtml: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    icon: (name) => `<svg data-icon="${name}"></svg>`,
  });
  for (const file of ['charts3d.js', 'charging.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  run.set = (name, value) => { context.__value = JSON.parse(JSON.stringify(value)); vm.runInContext(`${name} = __value`, context); };
  return run;
}
const withData = (run, member, day = '2026-01-25', window = 'evening') => {
  run.set('dw.data', { ...OFFERS, member });
  run(`dw.status = "ready"; dw.day = "${day}"; dw.window = "${window}"; dw.kwh = 20`);
};

test('joining is optional and the normal price stays available', () => {
  const run = load();
  withData(run, { joined: false, bookings: [] });
  const html = run('dwCard()');
  assert.match(html, /data-dw-act="join"[^>]*>Join free \(demo\)/);
  assert.match(html, /anyone can charge at the normal price, €0\.49\/kWh, without joining/);
  assert.match(html, /07:00–09:00<\/b> or <b>17:00–19:00/);
});

test('an offer shows the server\'s locked price for the chosen charge size', () => {
  const run = load();
  withData(run, { joined: true, bookings: [] });
  let html = run('dwCard()');
  const offer = SECTION.offers.find((o) => o.date === '2026-01-25' && o.window === 'evening');
  assert.equal(offer.status, 'offer');
  assert.match(html, /€0\.44<small>\/kWh<\/small><\/b><em>−€0\.05/);
  assert.match(html, /You pay <b>€8\.80<\/b> instead of €9\.80 · save <b>€1\.00/);
  assert.match(html, new RegExp(`${offer.sessions} places · price fixed now`));
  run('dw.kwh = 10');
  html = run('dwCard()');
  const q = offer.quotes.find((x) => x.kwh === 10);
  assert.ok(html.includes(`You pay <b>€${q.priceEur.toFixed(2)}</b> instead of €${q.publicEur.toFixed(2)}`), 'the quote comes from the server');
});

test('a window without an offer says so and points to the next opportunity', () => {
  const run = load();
  withData(run, { joined: true, bookings: [] }, '2026-01-25', 'morning');
  const html = run('dwCard()');
  assert.match(html, /No discounted window right now/);
  assert.match(html, /Stored surplus is not cheaper than normal charging in this window\. Normal charging stays open at €0\.49\/kWh/);
  assert.match(html, /data-dw-day="2026-01-25" data-dw-pick="evening">Next opportunity: Sun, 25 Jan 17:00–19:00/);
});

test('a reservation shows the price, the saving, the split and a free cancel', () => {
  const run = load();
  const offer = SECTION.offers.find((o) => o.date === '2026-01-25' && o.window === 'evening');
  const quote = offer.quotes.find((x) => x.kwh === 20);
  withData(run, { joined: true, bookings: [{ offerId: offer.id, status: 'reserved', ...quote }] });
  const html = run('dwCard()');
  assert.match(html, /Reserved · 20 kWh/);
  assert.match(html, /Cancel \(no fee\)/);
  assert.match(html, /You pay <b>€8\.80<\/b> instead of €9\.80 · save <b>€1\.00/);
  assert.match(html, /Operator keeps €0\.50 · our commission €0\.50/);
});
