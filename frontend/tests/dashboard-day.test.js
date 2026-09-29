const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The /api/v1/dashboard/day answer for 11 Jan 2026 (real figures).
const DAY = {
  date: '2026-01-11', model: { id: 'v2', version: '2.0.0-daily-experimental', experimental: true, test: { rows: 242, dailyMaeMwh: 1723.39, zeroBaselineMaeMwh: 2310.37, rocAuc: 0.823 } },
  issuedAt: '2026-01-11T00:00:00+00:00', weatherAvailableAt: '2026-01-10T23:00:00+00:00', probability: 0.9478, predictedMwh: 8962.79,
  split: { status: 'ok', windMwh: 8846.09, solarMwh: 116.69, windSharePercent: 98.7, solarSharePercent: 1.3, version: '2.0.0-sources-experimental' },
  recorded: { status: 'available', curtailmentMwh: 7010.69, split: { status: 'available', windMwh: 6983.6, solarMwh: 27.09, windSharePercent: 99.61, solarSharePercent: 0.39 } },
};
const HALF_HOUR = { targetAt: '2026-01-11T14:00:00+00:00', horizonMinutes: 30, atRiskMwh: 44.2, probability: 1, risk: 'high', lowerMwh: 30, upperMwh: 60 };

function load(dataMode = 'historical-prediction') {
  const context = vm.createContext({
    document: { addEventListener() {} },
    modelState: { data: { dataMode, intervalMinutes: 30, predictions: [HALF_HOUR] }, horizon: 30 },
    settings: { timezone: 'UTC' },
    n: (value) => new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value),
    escapeHtml: (value) => String(value),
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    cardHead: (tone, title, subtitle, extra = '') => `<div class="head"><h2>${title}</h2><p>${subtitle}</p>${extra}</div>`,
    modelTime: (value) => new Date(value).toISOString().slice(11, 16),
    selectedPrediction: () => HALF_HOUR,
    pageFromHash: () => 'overview',
    render() {},
    fetch: async () => { throw new Error('no network in tests'); },
  });
  for (const file of ['charts3d.js', 'dashboard.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const run = (code) => vm.runInContext(code, context);
  context.DAY = DAY;
  return run;
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the top card shows the daily model for the dashboard day', () => {
  const run = load();
  run(`Object.assign(dashDay, { key: '2026-01-11', status: 'ready', data: DAY })`);
  const html = text(run('dashboardHero(selectedPrediction())'));
  assert.match(html, /Curtailment forecast for the day/);
  assert.match(html, /8,963 MWh/);
  assert.match(html, /99% wind · 1% solar/);
  assert.match(html, /EirGrid recorded 7,011 MWh/);
  assert.match(html, /Sun 11 Jan 2026/);
  assert.equal(run('dashCharts.dayLikelihood.values().risk'), 'high');
});

test('the second card compares predicted with recorded and links the half-hour plan', () => {
  const run = load();
  run(`Object.assign(dashDay, { key: '2026-01-11', status: 'ready', data: DAY })`);
  const html = text(run('dashboardConfidence(selectedPrediction())'));
  assert.match(html, /Forecast vs what happened/);
  assert.match(html, /Model 2 for Sun 11 Jan 2026 against EirGrid’s record · typically off by 1,723 MWh a day/);
  assert.match(html, /Battery and EV plan: 14:00–14:30 this day · model 1, \+30 min · 44\.2 MWh at risk/);
  const chart = run('dashCharts.dayCompare.draw(dashCharts.dayCompare.values())');
  assert.match(chart, /8,963 MWh/);
  assert.match(chart, /7,011 MWh/);
  assert.match(chart, /99% wind/);
  assert.match(chart, /100% wind/);
});

test('until the daily view arrives, or for demo data, the half-hour cards are shown', () => {
  const run = load();
  assert.match(text(run('dashboardHero(selectedPrediction())')), /Renewable energy at risk/);
  run(`Object.assign(dashDay, { key: '2026-01-11', status: 'loading', data: null })`);
  assert.match(text(run('dashboardHero(selectedPrediction())')), /Loading the daily forecast/);
  run(`Object.assign(dashDay, { status: 'error', error: 'down' })`);
  assert.match(text(run('dashboardHero(selectedPrediction())')), /Renewable energy at risk/);
  assert.match(text(run('dashboardConfidence(selectedPrediction())')), /Forecast confidence/);
  assert.equal(load('simulated')('dashDayKey()'), '', 'demo data never asks for a daily view');
});

test('a day with nothing recorded says so instead of drawing a 0% / 100% mix', () => {
  const run = load();
  run(`Object.assign(dashDay, { key: '2026-01-11', status: 'ready', data: { ...DAY, recorded: { status: 'available', curtailmentMwh: 0, split: null } } })`);
  assert.match(run('dashCharts.dayCompare.draw(dashCharts.dayCompare.values())'), /nothing was curtailed/);
});
