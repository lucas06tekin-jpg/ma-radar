const $ = (s) => document.querySelector(s);
const LABEL = { good: 'Bra', neutral: 'Neutralt', bad: 'Dåligt' };
const STATUS = { announced: 'Tillkännagiven', rumor: 'Rykte', completed: 'Slutförd', rejected: 'Avvisad', other: '' };
let deals = [];
let minImp = 1;
let onlySe = false;
const focusId = new URLSearchParams(location.search).get('deal');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (d) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(d)) / 60000));
  return m < 60 ? `${m} min sedan` : m < 1440 ? `${Math.round(m / 60)} h sedan` : `${Math.round(m / 1440)} d sedan`;
};

function render() {
  const list = deals.filter((d) => (d.importance || 1) >= minImp && (!onlySe || d.swedish));
  $('#list').innerHTML = list.length ? list.map((d) => `
    <article class="card ${d.id === focusId ? 'hl' : ''}">
      <div class="top">
        <div class="names">${esc(d.acquirer)} → ${esc(d.target)}</div>
        ${d.value_text || d.value_usd_bn ? `<div class="val">${d.value_text ? esc(d.value_text) : '$' + esc(d.value_usd_bn) + ' mdr'}</div>` : ''}
      </div>
      <div class="meta">${[STATUS[d.status], d.sector, ago(d.date), d.source].filter(Boolean).map(esc).join(' · ')}</div>
      <p class="sum">${esc(d.summary)}</p>
      <div class="verdicts">
        <div class="v ${esc(d.acquirer_verdict)}"><b>Köpare: ${esc(d.acquirer)}</b><span class="t">${LABEL[d.acquirer_verdict] || ''}</span> – ${esc(d.acquirer_reason)}</div>
        <div class="v ${esc(d.target_verdict)}"><b>Mål: ${esc(d.target)}</b><span class="t">${LABEL[d.target_verdict] || ''}</span> – ${esc(d.target_reason)}</div>
      </div>
      ${d.link ? `<p style="margin:10px 0 0"><a href="${esc(d.link)}" target="_blank" rel="noopener">Läs artikeln →</a></p>` : ''}
    </article>`).join('') : '<div class="empty">Inga affärer ännu – nya dyker upp automatiskt.</div>';
}

const C = window.CONFIG;
const sbHeaders = { apikey: C.SUPABASE_KEY, Authorization: 'Bearer ' + C.SUPABASE_KEY, 'Content-Type': 'application/json' };
const rpc = (fn, args) => fetch(C.SUPABASE_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: sbHeaders, body: JSON.stringify(args) });

async function load() {
  try {
    const r = await fetch(C.SUPABASE_URL + '/rest/v1/ma_deals?select=data&order=created_at.desc&limit=100', { headers: sbHeaders });
    deals = (await r.json()).map((x) => x.data);
  } catch {}
  render();
}

document.querySelectorAll('.chip[data-min]').forEach((c) => c.addEventListener('click', () => {
  document.querySelectorAll('.chip[data-min]').forEach((x) => x.classList.remove('active'));
  c.classList.add('active');
  minImp = Number(c.dataset.min);
  render();
}));
$('#se').addEventListener('click', (e) => {
  onlySe = !onlySe;
  e.currentTarget.classList.toggle('active', onlySe);
  render();
});

// ---------- push ----------
const urlB64 = (b) => {
  const p = '='.repeat((4 - (b.length % 4)) % 4);
  const r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...r].map((c) => c.charCodeAt(0)));
};
const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
let reg;

async function refreshBell() {
  const sub = reg && (await reg.pushManager.getSubscription());
  $('#bell').classList.toggle('on', !!sub);
  $('#bell').textContent = sub ? '🔔 På' : '🔔 Notiser';
}

$('#bell').addEventListener('click', async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return alert('Notiser stöds inte här. På iPhone: öppna i Safari → Dela → "Lägg till på hemskärmen" och öppna appen därifrån (iOS 16.4+).');
  }
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await rpc('ma_unsubscribe', { p_endpoint: existing.endpoint });
    await existing.unsubscribe();
    return refreshBell();
  }
  if ((await Notification.requestPermission()) !== 'granted') return alert('Notiser nekades.');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(C.VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  await rpc('ma_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_min: minImp });
  await reg.showNotification('M&A Radar', { body: 'Notiser fungerar ✅', icon: 'icon-192.png' });
  refreshBell();
});

(async () => {
  if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) {
    $('#banner').innerHTML = '<div class="banner">📲 För notiser: tryck <b>Dela</b> i Safari → <b>Lägg till på hemskärmen</b>, öppna sedan appen därifrån och tryck på 🔔.</div>';
  }
  if ('serviceWorker' in navigator) {
    reg = await navigator.serviceWorker.register('sw.js');
    refreshBell();
  }
  load();
  setInterval(load, 60000);
})();
