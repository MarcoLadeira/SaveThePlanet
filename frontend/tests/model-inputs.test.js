const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness() {
  const inputs = {}, listeners = {}, timers = new Map(), requests = [];
  let timerId = 0;
  const document = { activeElement: null, getElementById: id => inputs[id] || null,
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) };
  const context = vm.createContext({
    document, URLSearchParams, AbortController, localStorage: { getItem: () => null },
    pinnedTargetAfter: () => null, render() {}, pageFromHash: () => 'settings',
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: url => url.includes('/health')
      ? Promise.resolve({ ok: true, json: async () => ({}) })
      : new Promise(resolve => requests.push({ url, resolve })),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../model.js'), 'utf8'), context);
  function input(id, value, min, max) {
    inputs[id] = { id, value, message: '',
      setCustomValidity(message) { this.message = message; },
      get validationMessage() { return this.message; },
      get validity() { return { valid: !this.message && this.value !== '' && Number(this.value) >= min && Number(this.value) <= max }; },
    };
    return inputs[id];
  }
  input('model-capacity', '100', .001, 10000);
  return {
    inputs, requests, input, state: () => vm.runInContext('modelState', context),
    edit(id, value, type = 'input') {
      inputs[id].value = value;
      for (const fn of listeners[type] || []) fn({ target: inputs[id] });
    },
    flush() { for (const [id, t] of timers) if (t.delay === 500) { timers.delete(id); t.fn(); } },
    async respond(index, label) {
      requests[index].resolve({ok: true,json: async () => ({label,predictions: [{}, {}],scenario: {outcomes: [{}, {}]}})});
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
test('typing applies capacity after one debounced request and blur does not duplicate', async () => {
  const h = harness();
  h.edit('model-capacity', '2'); h.edit('model-capacity', '25');
  assert.equal(h.requests.length, 0); h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(new URL(h.requests[0].url, 'http://local').searchParams.get('capacityMw'), '25');
  h.edit('model-capacity', '25', 'change'); assert.equal(h.requests.length, 1);
  await h.respond(0, 'updated'); assert.equal(h.state().data.label, 'updated');
});
test('invalid and empty capacity never send a request', () => {
  const h = harness(); h.edit('model-capacity', '10');
  for (const invalid of ['', '0', '10001', '-1']) { h.edit('model-capacity', invalid); h.flush(); assert.equal(h.requests.length, 0); }
  h.edit('model-capacity', '10'); h.flush(); assert.equal(h.requests.length, 1);
});
test('demand updates only with a valid total/flexible combination', () => {
  const h = harness();
  h.input('scenario-total', '1000', 0, 1e9);
  h.input('scenario-flexible', '500', 0, 1e9);
  h.inputs['scenario-validation'] = {textContent: ''};
  h.edit('scenario-flexible', '1500'); h.flush(); assert.equal(h.requests.length, 0);
  assert.match(h.inputs['scenario-validation'].textContent, /must not exceed/);
  h.edit('scenario-total', '2000', 'change'); h.flush();
  const params = new URL(h.requests[0].url, 'http://local').searchParams;
  assert.equal(params.get('totalDemandKwh'), '2000');
  assert.equal(params.get('flexibleDemandKwh'), '1500');
});
test('out-of-order responses cannot overwrite the latest values', async () => {
  const h = harness(); h.edit('model-capacity', '20'); h.flush(); h.edit('model-capacity', '30'); h.flush();
  await h.respond(1, 'latest'); await h.respond(0, 'stale');
  assert.equal(h.state().data.label, 'latest'); assert.equal(h.state().capacity, 30);
});
