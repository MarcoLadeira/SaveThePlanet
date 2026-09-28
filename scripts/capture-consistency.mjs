// Re-review evidence for PR #40: one pinned target across Dashboard, Charging, Impact and Volt.
// Drives one headless Chrome session over the DevTools protocol (Node 22+ has WebSocket built in),
// so the page keeps a single pinned target while it moves between pages.
//
//   python backend/server.py                      # in another terminal
//   node scripts/capture-consistency.mjs [out-dir] [chrome-path]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] || 'docs/screenshots/pr40';
const chromePath = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const app = 'http://127.0.0.1:8080/';
const port = 9333;
mkdirSync(out, { recursive: true });

const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars',
  `--user-data-dir=${join(tmpdir(), `pr40-capture-${Date.now()}`)}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function page() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const tab = targets.find((t) => t.type === 'page');
      if (tab) return tab.webSocketDebuggerUrl;
    } catch { /* Chrome still starting */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await page());
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
async function until(expression, seconds = 90) {
  for (let i = 0; i < seconds * 4; i++) {
    if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function shot(name) {
  await evaluate("dispatchEvent(new Event('resize'))");
  await sleep(900);
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, name), Buffer.from(result.data, 'base64'));
  console.log('saved', join(out, name));
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: `${app}?capture=${Date.now()}#overview` });
await until('typeof modelState!=="undefined" && modelState.data && !modelState.loading && modelState.target');
const pinned = await evaluate('modelState.target');
console.log('pinned target', pinned);
await shot('1-dashboard.png');

await evaluate("location.hash='charging'");
await until(`location.hash==='#charging' && !modelState.loading && modelState.target===${JSON.stringify(pinned)}
  && typeof cgDay!=='undefined' && cgDay.status==='ready' && cgDay.data.date===${JSON.stringify(pinned.slice(0, 10))}`, 120);
await shot('2-charging.png');

await evaluate("location.hash='impact'");
await until(`typeof impactDay!=='undefined' && impactDay.status==='ready' && impactDay.date===${JSON.stringify(pinned.slice(0, 10))}`, 120);
await shot('3-impact.png');

await evaluate("location.hash='overview'");
await until('document.querySelector(".volt-toggle")');
await evaluate(`(()=>{document.querySelector('.volt-toggle').click();
  const input=document.querySelector('.volt-input'); input.value='How much energy is at risk, and how was this half-hour chosen?';
  document.querySelector('.volt-form').requestSubmit();})()`);
await until('document.querySelector(".volt-source")', 60);
await shot('4-volt.png');

const summary = await evaluate(`({pinned:modelState.target, dashboard:modelState.data.predictions[0].targetAt,
  chargingDay:cgDay.data.date, impactDay:impactDay.date, volt:[...document.querySelectorAll('.volt-source')].at(-1)?.innerText})`);
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(summary);
ws.close();
chrome.kill();
