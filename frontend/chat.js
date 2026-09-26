// Volt: floating in-app assistant. Lives outside #app so re-renders never wipe it.
// Every figure, badge and button is rendered from structured server fields; model text is shown as plain text only.
const chatState = { open: false, busy: false, messages: [] };
const chatPageNames = { overview: 'Dashboard', forecast: 'Forecast', charging: 'Charging', impact: 'Impact', settings: 'Settings' };
const chatStarters = ["What's at risk?", 'How much could charging absorb?', 'Explain curtailment'];

function voltSourceBadge() {
  const d = modelState.data;
  if (!d) return `<span class="volt-badge">${modelState.loading ? 'Loading data' : 'No forecast'}</span>`;
  return d.dataMode === 'simulated'
    ? '<span class="volt-badge is-sim">Simulated</span>'
    : '<span class="volt-badge">Historical forecast</span>';
}

function voltValue(value) {
  return typeof value === 'number'
    ? new Intl.NumberFormat('en-IE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)
    : escapeHtml(value);
}

function voltCard(card) {
  const rows = card.rows.map(r => `<div class="volt-row"><strong>${voltValue(r.value)}<small> ${escapeHtml(r.unit)}</small></strong>
    <span>${escapeHtml(r.label)}${r.at ? ` · ${escapeHtml(modelTime(r.at))}` : ''}</span></div>`).join('');
  const meta = card.meta.map(m => `<div><dt>${escapeHtml(m.label)}</dt><dd>${escapeHtml(m.value)}</dd></div>`).join('');
  return `<div class="volt-card"><h3>${escapeHtml(card.title)}</h3>${rows || '<p class="volt-note">No values available for this answer.</p>'}
    ${card.note ? `<p class="volt-note">${escapeHtml(card.note)}</p>` : ''}${meta ? `<dl class="volt-meta">${meta}</dl>` : ''}</div>`;
}

function voltProvenance(p) {
  return `<div class="volt-source"><span class="volt-badge ${p.mode === 'simulated' ? 'is-sim' : ''}">${escapeHtml(p.label)}</span>
    <span>${escapeHtml(p.region)} · issued ${escapeHtml(modelTime(p.issuedAt, true))}</span></div>`;
}

function voltReply(m, latest) {
  const r = m.reply;
  const actions = [
    r.navigate && chatPageNames[r.navigate] ? `<button type="button" class="volt-go" data-page="${r.navigate}">View ${chatPageNames[r.navigate]} ${icon('arrow', 14)}</button>` : '',
    latest && r.followUp ? `<button type="button" class="volt-chip" data-volt-ask="${escapeHtml(r.followUp)}">${escapeHtml(r.followUp)}</button>` : '',
  ].join('');
  return `<div class="volt-msg bot">${r.notice ? `<p class="volt-notice">${escapeHtml(r.notice)}</p>` : ''}
    ${r.card ? voltCard(r.card) : ''}<p>${escapeHtml(r.text)}</p>${r.provenance ? voltProvenance(r.provenance) : ''}
    ${actions ? `<div class="volt-actions">${actions}</div>` : ''}</div>`;
}

function voltMessage(m, index) {
  if (m.role === 'user') return `<div class="volt-msg user"><p>${escapeHtml(m.text)}</p></div>`;
  if (m.error) return `<div class="volt-msg bot error"><p>${escapeHtml(m.text)}</p><div class="volt-actions"><button type="button" class="volt-chip" data-volt-retry>Try again</button></div></div>`;
  return voltReply(m, index === chatState.messages.length - 1);
}

function renderChat({ scroll = false } = {}) {
  const root = document.getElementById('volt');
  root.dataset.theme = dashboardTheme;
  root.classList.toggle('open', chatState.open);
  root.querySelector('.volt-toggle').setAttribute('aria-expanded', chatState.open);
  root.querySelector('.volt-status').innerHTML = voltSourceBadge();
  root.querySelector('.volt-reset').hidden = !chatState.messages.length;
  const log = root.querySelector('.volt-log');
  // Keep the reader's place unless they were already at the bottom or just sent a message.
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const previous = log.scrollTop;
  const intro = `<div class="volt-msg bot"><p>Hi, I'm Volt. Ask about the forecast, charging or impact, and I'll show the figures and where they come from.</p>
    ${chatState.messages.length ? '' : `<div class="volt-actions">${chatStarters.map(s => `<button type="button" class="volt-chip" data-volt-ask="${escapeHtml(s)}">${s}</button>`).join('')}</div>`}</div>`;
  log.innerHTML = intro + chatState.messages.map(voltMessage).join('')
    + (chatState.busy ? '<div class="volt-msg bot typing" aria-hidden="true"><i></i><i></i><i></i></div>' : '');
  log.scrollTop = scroll || nearBottom ? log.scrollHeight : previous;
  root.querySelector('.volt-send').disabled = chatState.busy;
}

function voltAnnounce(text) {
  const live = document.querySelector('.volt-live');
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
}

async function chatSend(text) {
  text = text.trim().slice(0, 1000);
  if (!text || chatState.busy) return;
  chatState.messages = chatState.messages.filter(m => !m.error);
  chatState.messages.push({ role: 'user', text });
  chatState.busy = true;
  renderChat({ scroll: true });
  const history = chatState.messages.slice(-24).map(m => ({ role: m.role, text: m.role === 'user' ? m.text : m.reply.text }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch('/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      // Only safe selectors are sent; the server rebuilds every figure itself.
      body: JSON.stringify({ messages: history, page: pageFromHash(), horizon: modelState.horizon, capacityMw: modelState.capacity,
        totalDemandKwh: modelState.totalDemandKwh, flexibleDemandKwh: modelState.flexibleDemandKwh }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Volt could not answer.');
    chatState.messages.push({ role: 'assistant', text: body.reply.text, reply: body.reply });
    voltAnnounce([body.reply.card?.title, body.reply.text].filter(Boolean).join('. '));
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Volt took too long to answer.' : 'Volt could not reach the server.';
    chatState.messages.push({ role: 'assistant', text: message, error: true, retry: text });
    voltAnnounce(message);
  } finally {
    clearTimeout(timer);
    chatState.busy = false;
    renderChat();
  }
}

function setChatOpen(open) {
  chatState.open = open;
  renderChat({ scroll: open });
  document.querySelector(open ? '.volt-input' : '.volt-toggle').focus();
}

document.body.insertAdjacentHTML('beforeend', `
  <div id="volt" class="volt">
    <section class="volt-panel" role="dialog" aria-label="Volt, your energy assistant">
      <header class="volt-head"><span class="volt-avatar">${icon('bolt', 18)}</span>
        <div class="volt-title"><strong>Volt</strong><small>Your energy assistant</small></div>
        <span class="volt-status"></span>
        <button type="button" class="volt-icon volt-reset" aria-label="New conversation" title="New conversation" hidden>${icon('swap', 16)}</button>
        <button type="button" class="volt-icon volt-close" aria-label="Close Volt">×</button></header>
      <div class="volt-log"></div>
      <div class="sr-only volt-live" aria-live="polite"></div>
      <form class="volt-form"><input class="volt-input" maxlength="1000" placeholder="Ask about the forecast…" aria-label="Message Volt" autocomplete="off">
        <button class="volt-send" aria-label="Send">${icon('arrow', 16)}</button></form>
    </section>
    <button type="button" class="volt-toggle" aria-label="Open Volt assistant" aria-expanded="false">${icon('bolt', 26)}</button>
  </div>`);

document.addEventListener('click', event => {
  if (event.target.closest('.volt-toggle')) return setChatOpen(!chatState.open);
  if (event.target.closest('.volt-close')) return setChatOpen(false);
  if (event.target.closest('.volt-reset')) {
    chatState.messages = [];
    renderChat();
    return document.querySelector('.volt-input').focus();
  }
  const retry = event.target.closest('[data-volt-retry]');
  if (retry) {
    const last = chatState.messages.pop();
    if (chatState.messages.at(-1)?.role === 'user') chatState.messages.pop();
    return chatSend(last.retry);
  }
  const ask = event.target.closest('[data-volt-ask]');
  if (ask) return chatSend(ask.dataset.voltAsk);
  // Theme or data may have changed through the main app; refresh the badge and colours.
  if (chatState.open && !event.target.closest('#volt')) setTimeout(renderChat);
});
document.addEventListener('submit', event => {
  if (!event.target.classList.contains('volt-form')) return;
  event.preventDefault();
  const input = event.target.querySelector('.volt-input');
  chatSend(input.value);
  input.value = '';
});
addEventListener('keydown', event => { if (event.key === 'Escape' && chatState.open) setChatOpen(false); });
addEventListener('hashchange', () => renderChat());
renderChat();
