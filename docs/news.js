// Nyheter: finansrubriker från CNBC, FT, WSJ, Di, DN, SvD med flera, med svensk sammanfattning, betalväggsmärkning och notiser.
// Servern (Supabase) hämtar, sammanfattar och bedömer varje nyhet. Appen läser bara den färdiga listan.
(() => {
  const C = window.CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const root = () => $('#view-news');
  const H = { apikey: C.SUPABASE_KEY, Authorization: 'Bearer ' + C.SUPABASE_KEY };
  const rpc = (fn, args) => window.Terms.rpc(fn, args);

  const LEVELS = { 5: 'Bara de största', 4: 'Viktiga och större', 3: 'Alla utom småsaker' };
  const TOPIC = { marknad: 'Marknad', bolag: 'Bolag', makro: 'Makro', räntor: 'Räntor', affärer: 'Affärer', råvaror: 'Råvaror', krypto: 'Krypto', svenskt: 'Sverige', övrigt: '' };
  const ERR = { invalid: 'Något gick fel när inställningen skulle sparas.', network: 'Kunde inte nå servern. Försök igen.' };

  let items = [];
  let loaded = false;
  let built = false;
  let filter = 'all'; // all | big | sv | en
  let hidePaid = false;
  try { hidePaid = localStorage.getItem('ma.news.hidePaid') === '1'; } catch {}
  const note = { loaded: false, busy: false, endpoint: null, server: { exists: false }, min: 4, hide: false, msg: '', open: false };

  const ago = (d) => {
    const m = Math.max(1, Math.round((Date.now() - new Date(d)) / 60000));
    return m < 60 ? `${m} min sedan` : m < 1440 ? `${Math.round(m / 60)} h sedan` : `${Math.round(m / 1440)} d sedan`;
  };

  // ---------- nyhetslistan ----------
  async function loadItems() {
    try {
      const r = await fetch(`${C.SUPABASE_URL}/rest/v1/ma_news?select=id,url,title,source,lang,published,summary_sv,importance,topic,companies,paywall&order=published.desc&limit=150`, { headers: H });
      if (r.ok) { items = await r.json(); loaded = true; }
    } catch {}
    renderList();
  }

  function renderList() {
    const el = $('#nlist');
    if (!el) return;
    let list = items;
    if (filter === 'big') list = list.filter((n) => n.importance >= 4);
    if (filter === 'sv') list = list.filter((n) => n.lang === 'sv');
    if (filter === 'en') list = list.filter((n) => n.lang === 'en');
    if (hidePaid) list = list.filter((n) => n.paywall !== 'paid');
    if (!loaded) { el.innerHTML = '<div class="empty">Laddar nyheter…</div>'; return; }
    el.innerHTML = list.length ? list.map((n) => `
      <article class="card ncard">
        <div class="nmeta">
          <b>${esc(n.source)}</b><span>${esc(ago(n.published))}</span>
          ${n.paywall === 'paid' ? '<span class="npill paid" title="Kräver ofta prenumeration">🔒 Betalvägg</span>' : ''}
          ${n.importance >= 5 ? '<span class="npill big">Stor nyhet</span>' : n.importance === 4 ? '<span class="npill imp">Viktig</span>' : ''}
        </div>
        <a class="ntitle" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        ${n.summary_sv ? `<p class="nsum">${esc(n.summary_sv)}</p>` : ''}
        ${(TOPIC[n.topic] || (n.companies && n.companies.length)) ? `<div class="ntags">${[TOPIC[n.topic], ...(n.companies || [])].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </article>`).join('')
      : `<div class="empty">${items.length ? 'Inga nyheter i det här urvalet.' : 'Inga nyheter ännu. De dyker upp inom några minuter.'}</div>`;
  }

  // ---------- notiser ----------
  async function loadNoteState() {
    note.loaded = true;
    note.endpoint = await window.PushUtil.currentEndpoint();
    if (note.endpoint) {
      const s = await rpc('ma_news_sub_get', { p_endpoint: note.endpoint });
      if (s && s.exists) { note.server = s; note.min = s.min; note.hide = s.hide_paid; }
    }
    renderNote();
  }

  function renderNote() {
    const el = $('#nnote');
    if (!el) return;
    const on = note.server.exists && note.server.enabled;
    const blocked = window.PushUtil.blockedReason();
    el.innerHTML = `
      <button class="nnotehead" id="ntoggle" aria-expanded="${note.open}">
        <span>🔔 Nyhetsnotiser: <b>${on ? 'På' : 'Av'}</b></span><span class="nchev">${note.open ? '▲' : '▼'}</span>
      </button>
      ${note.open ? `
        <div class="nnotebody">
          ${blocked ? `<div class="banner">📲 ${esc(blocked)}</div>` : ''}
          <div class="qlabel">Vilka nyheter ger notis</div>
          <div class="qchips" id="nlevel">
            ${[5, 4, 3].map((k) => `<button class="chip ${note.min === k ? 'active' : ''}" data-min="${k}">${LEVELS[k]}</button>`).join('')}
          </div>
          <label class="gremember" style="margin-top:12px"><input type="checkbox" id="nhide" ${note.hide ? 'checked' : ''}> Hoppa över betalartiklar</label>
          <button class="qbtn primary" id="nsave" ${blocked || note.busy ? 'disabled' : ''}>${on ? 'Uppdatera' : 'Slå på nyhetsnotiser'}</button>
          ${on ? '<button class="qbtn ghost" id="noff">Stäng av nyhetsnotiser</button>' : ''}
          <div class="iqnote" id="nmsg" role="status">${esc(note.msg)}</div>
        </div>` : ''}`;
    $('#ntoggle').onclick = () => { note.open = !note.open; if (note.open && !note.loaded) loadNoteState(); renderNote(); };
    if (!note.open) return;
    $('#nlevel').onclick = (e) => { const b = e.target.closest('[data-min]'); if (b) { note.min = Number(b.dataset.min); note.msg = ''; renderNote(); } };
    $('#nhide').onchange = (e) => { note.hide = e.target.checked; };
    const save = $('#nsave'), off = $('#noff');
    if (save) save.onclick = doSave;
    if (off) off.onclick = doOff;
  }

  async function doSave() {
    note.busy = true; $('#nsave').disabled = true;
    try {
      const sub = await window.PushUtil.ensure(); // måste ske direkt från knapptrycket
      const j = sub.toJSON();
      const r = await rpc('ma_news_sub_save', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_min: note.min, p_hide_paid: note.hide });
      if (!r.ok) throw new Error(ERR[r.error] || ERR.network);
      note.endpoint = j.endpoint;
      note.server = { exists: true, enabled: true, min: note.min, hide_paid: note.hide };
      note.msg = 'Sparat. Du får en notis när en nyhet på den nivån kommer.';
    } catch (e) {
      note.msg = e.message === 'blocked' ? 'Notiser är blockerade. Tillåt dem för appen i iPhonens inställningar.' : 'Det gick inte att slå på notiser: ' + e.message;
    }
    note.busy = false;
    renderNote();
  }

  async function doOff() {
    note.busy = true;
    const r = await rpc('ma_news_sub_delete', { p_endpoint: note.endpoint });
    note.busy = false;
    if (r.ok) { note.server = { exists: false }; note.msg = 'Nyhetsnotiserna är avstängda.'; } else note.msg = ERR[r.error] || ERR.network;
    renderNote();
  }

  // ---------- uppbyggnad ----------
  function build() {
    root().innerHTML = `
      <div class="card" id="nnote" style="padding:0"></div>
      <div class="qchips nfilters" id="nfilters">
        <button class="chip active" data-f="all">Alla</button>
        <button class="chip" data-f="big">Viktiga</button>
        <button class="chip" data-f="sv">🇸🇪 Svenska</button>
        <button class="chip" data-f="en">🇬🇧 Engelska</button>
      </div>
      <label class="gremember" style="margin:8px 0 12px"><input type="checkbox" id="nhidepaid" ${hidePaid ? 'checked' : ''}> Dölj betalartiklar 🔒</label>
      <div id="nlist"></div>
      <p class="iqnote">Sammanfattningar och bedömningar är AI-genererade från rubrik och ingress, inte från hela artikeln, och är inte finansiell rådgivning. 🔒 betyder att artikeln ofta kräver prenumeration hos källan. Utan märke är den gratis eller okänd.</p>`;
    $('#nfilters').onclick = (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      filter = b.dataset.f;
      document.querySelectorAll('#nfilters .chip').forEach((c) => c.classList.toggle('active', c === b));
      renderList();
    };
    $('#nhidepaid').onchange = (e) => {
      hidePaid = e.target.checked;
      try { localStorage.setItem('ma.news.hidePaid', hidePaid ? '1' : '0'); } catch {}
      renderList();
    };
    renderNote();
    renderList();
  }

  let timer = null;
  window.onNewsShow = () => {
    if (!built) { built = true; build(); }
    loadItems();
    if (!note.loaded) loadNoteState();
    clearInterval(timer);
    timer = setInterval(() => { if (!root().hidden) loadItems(); else clearInterval(timer); }, 60000);
  };
})();
