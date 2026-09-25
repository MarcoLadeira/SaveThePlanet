// Volt: floating in-app assistant. Lives outside #app so re-renders never wipe it.
const chatState = { open: false, busy: false, messages: [] };
const chatPageNames = { overview: 'Dashboard', forecast: 'Forecast', charging: 'Charging', impact: 'Impact', settings: 'Settings' };
const chatSuggestions = ['Summarise this page', 'What is curtailment?', 'Which forecast should I use?'];

function chatContext() {
  const d = modelState.data;
  if (!d) return { status: modelState.loading ? 'loading' : modelState.error || 'no data' };
  const s = d.scenario;
  return {
    dataMode: d.dataMode, source: d.source, modelVersion: d.modelVersion, region: d.region,
    selectedHorizonMinutes: modelState.horizon, flexibleCapacityMw: d.flexibleCapacityMw,
    predictions: d.predictions.map(p => ({ horizonMinutes: p.horizonMinutes, targetAt: p.targetAt, probability: p.probability,
      risk: p.risk, atRiskMwh: p.atRiskMwh, curtailmentMwh: p.curtailmentMwh, constraintMwh: p.constraintMwh,
      p10Mwh: p.lowerMwh, p50Mwh: p.medianMwh, p90Mwh: p.upperMwh })),
    scenario: s && { totalDemandMwh: s.totalDemandMwh, flexibleDemandMwh: s.flexibleDemandMwh,
      recommendedHorizonMinutes: s.recommendedHorizonMinutes,
      outcomes: s.outcomes.map(o => ({ horizonMinutes: o.horizonMinutes, potentialRecoveryMwh: o.potentialRecoveryMwh,
        remainingWasteMwh: o.remainingWasteMwh, recoveryRate: o.recoveryRate, cleanChargingShare: o.cleanChargingShare })) },
    settings: { timezone: settings.timezone, uncertainty: settings.uncertainty, cause: settings.cause },
  };
}

function chatFormat(text) {
  const lines = escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[go:(\w+)\]\]/g, (m, page) => chatPageNames[page]
      ? `<button type="button" class="volt-go" data-page="${page}">Go to ${chatPageNames[page]} →</button>` : '')
    .split('\n');
  let html = '', list = false;
  for (const line of lines) {
    const item = line.match(/^\s*[-*•]\s+(.*)/);
    if (item && !list) { html += '<ul>'; list = true; }
    if (!item && list) { html += '</ul>'; list = false; }
    if (item) html += `<li>${item[1]}</li>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

function renderChat() {
  const root = document.getElementById('volt');
  root.dataset.theme = dashboardTheme;
  root.classList.toggle('open', chatState.open);
  root.querySelector('.volt-toggle').setAttribute('aria-expanded', chatState.open);
  const log = root.querySelector('.volt-log');
  const intro = `<div class="volt-msg bot"><p>Hi, I'm <strong>Volt</strong>. I can explain this page, summarise the forecast, or help you find your way around the planner.</p></div>`;
  const chips = chatState.messages.length ? '' : `<div class="volt-chips">${chatSuggestions.map(s => `<button type="button" data-volt-ask="${escapeHtml(s)}">${s}</button>`).join('')}</div>`;
  log.innerHTML = intro + chips + chatState.messages.map(m =>
    `<div class="volt-msg ${m.role === 'user' ? 'user' : m.error ? 'bot error' : 'bot'}">${m.role === 'user' ? `<p>${escapeHtml(m.text)}</p>` : chatFormat(m.text)}</div>`).join('')
    + (chatState.busy ? '<div class="volt-msg bot typing" aria-label="Volt is typing"><i></i><i></i><i></i></div>' : '');
  log.scrollTop = log.scrollHeight;
  root.querySelector('.volt-send').disabled = chatState.busy;
}

async function chatSend(text) {
  text = text.trim().slice(0, 1000);
  if (!text || chatState.busy) return;
  chatState.messages.push({ role: 'user', text });
  chatState.busy = true;
  renderChat();
  const history = chatState.messages.filter(m => !m.error).slice(-24).map(({ role, text }) => ({ role, text }));
  try {
    const response = await fetch('/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, page: pageFromHash(), context: chatContext() }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Volt is unavailable.');
    chatState.messages.push({ role: 'assistant', text: body.reply });
  } catch (error) {
    chatState.messages.push({ role: 'assistant', text: error.message || 'Volt is unavailable.', error: true });
  } finally {
    chatState.busy = false;
    renderChat();
  }
}

document.body.insertAdjacentHTML('beforeend', `
  <div id="volt" class="volt">
    <section class="volt-panel" role="dialog" aria-label="Volt assistant">
      <header class="volt-head"><span class="volt-avatar">${icon('bolt', 18)}</span><div><strong>Volt</strong><small>Planner assistant · answers about this app only</small></div>
        <button type="button" class="volt-close" aria-label="Close Volt">×</button></header>
      <div class="volt-log" aria-live="polite"></div>
      <form class="volt-form"><input class="volt-input" maxlength="1000" placeholder="Ask about this page…" aria-label="Message Volt" autocomplete="off">
        <button class="volt-send" aria-label="Send">${icon('arrow', 18)}</button></form>
    </section>
    <button type="button" class="volt-toggle" aria-label="Open Volt assistant" aria-expanded="false">${icon('bolt', 26)}</button>
  </div>`);

document.addEventListener('click', event => {
  if (event.target.closest('.volt-toggle, .volt-close')) {
    chatState.open = !chatState.open;
    renderChat();
    if (chatState.open) document.querySelector('.volt-input').focus();
  }
  const ask = event.target.closest('[data-volt-ask]');
  if (ask) chatSend(ask.dataset.voltAsk);
  if (event.target.closest('[data-dashboard-theme]')) renderChat();
});
document.addEventListener('submit', event => {
  if (!event.target.classList.contains('volt-form')) return;
  event.preventDefault();
  const input = event.target.querySelector('.volt-input');
  chatSend(input.value);
  input.value = '';
});
addEventListener('keydown', event => { if (event.key === 'Escape' && chatState.open) { chatState.open = false; renderChat(); } });
renderChat();
