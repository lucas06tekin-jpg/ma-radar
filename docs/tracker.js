// Jobbspårare: håll koll på jobb du sparat eller sökt, från Platsbanken-flödet och från andra sajter (LinkedIn, karriärsidor m.fl.).
// Lösenordsskyddad och lagrad i databasen, så den följer med mellan dina enheter. Samma lösenord som Intervju.
(() => {
  const C = window.CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rpc = (fn, args) => window.Terms.rpc(fn, args);

  const STATUS = { saved: 'Sparad', applied: 'Sökt', interview: 'Intervju', offer: 'Erbjudande', rejected: 'Avslag', withdrawn: 'Avbruten' };
  const ORDER = { interview: 0, offer: 1, saved: 2, applied: 3, rejected: 4, withdrawn: 5 };
  const GROUPS = [['all', 'Alla'], ['saved', 'Sparade'], ['applied', 'Sökta'], ['interview', 'Intervju'], ['offer', 'Erbjudande'], ['closed', 'Avslutade']];
  const ERR = {
    forbidden: 'Fel lösenord.', locked: 'För många felaktiga försök. Vänta 15 minuter.', not_configured: 'Lösenordet är inte inställt än.',
    invalid: 'Kontrollera fälten. Roll måste vara ifylld och länken måste börja med https://.', not_found: 'Jobbet finns inte längre.', network: 'Kunde inte nå servern. Försök igen.',
  };
  const SOURCES = ['LinkedIn', 'Karriärsida', 'Platsbanken', 'Indeed', 'Jobbsafari', 'Rekryterare', 'Nätverk', 'Annat'];

  const PASS_KEY = 'ma.admin';
  let pass = null;
  try { pass = sessionStorage.getItem(PASS_KEY) || localStorage.getItem(PASS_KEY) || null; } catch {}
  const forget = () => { pass = null; try { sessionStorage.removeItem(PASS_KEY); localStorage.removeItem(PASS_KEY); } catch {} };
  const remember = (p, persist) => { pass = p; try { (persist ? localStorage : sessionStorage).setItem(PASS_KEY, p); } catch {} };

  let host = null;
  let items = [];
  let loaded = false, loading = false;
  let filter = 'all';
  let form = null;            // null | { item } — det jobb som redigeras eller läggs till
  let flash = '';
  let pending = null;         // jobb som väntar på att spararen ska låsas upp
  const push = { loaded: false, endpoint: null, server: { exists: false }, days: [3, 1, 0], open: false, msg: '', busy: false };
  let quickOpen = false;
  const listeners = [];
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch {} });

  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const daysTo = (iso) => Math.round((new Date(iso + 'T00:00:00') - today()) / 864e5);
  const fmt = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const guessSource = (u) => {
    const h = hostOf(u);
    if (!h) return '';
    if (h.endsWith('linkedin.com')) return 'LinkedIn';
    if (h.endsWith('indeed.com')) return 'Indeed';
    if (h.endsWith('arbetsformedlingen.se')) return 'Platsbanken';
    if (h.endsWith('jobbsafari.se')) return 'Jobbsafari';
    return 'Karriärsida';
  };

  // Delar upp en sidrubrik från en annonssida, t.ex. "SEB hiring Analyst in Stockholm | LinkedIn" -> arbetsgivare, roll, ort
  function parseTitle(raw) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    const out = { title: '', employer: '', location: '' };
    t = t.replace(/^\(\d+\)\s*/, ''); // LinkedIn lägger "(3)" före rubriken när man har notiser
    const li = t.match(/^(.*?)\s+(?:hiring|söker)\s+(.*?)\s+(?:in|i)\s+(.*?)(?:\s*\|.*)?$/i);
    if (li) { out.employer = li[1]; out.title = li[2]; out.location = li[3]; return out; }
    out.title = t.replace(/\s*[|–—-]\s*(LinkedIn|Indeed.*|Glassdoor.*|Platsbanken.*|Jobbsafari.*)$/i, '').trim();
    return out;
  }

  // ---------- data ----------
  async function load() {
    if (loading) return;
    loading = true;
    const r = await rpc('ma_tracker_list', { p_pass: pass });
    loading = false;
    if (!r.ok) {
      if (r.error === 'forbidden') forget();
      flash = ERR[r.error] || ERR.network;
      loaded = false;
      return render();
    }
    items = r.items; loaded = true; flash = '';
    render(); notify();
    runPending();
  }

  async function save(item) {
    const r = await rpc('ma_tracker_save', { p_pass: pass, p_item: item });
    if (!r.ok && r.error === 'forbidden') { forget(); loaded = false; flash = ERR.forbidden; render(); }
    return r;
  }

  // ---------- publikt API (används av Jobb-flödet) ----------
  const api = {
    isSaved: (ref) => items.some((i) => i.job_ref === String(ref)),
    onChange: (fn) => listeners.push(fn),
    unlocked: () => !!pass && loaded,
    hasPass: () => !!pass,
    // Spara ett jobb från Platsbanken-flödet. Återger 'saved' | 'locked'.
    async saveFromFeed(j) {
      const item = {
        title: j.headline, employer: j.employer || '', location: j.municipality || '', url: j.url, source: 'Platsbanken', job_ref: String(j.id),
        deadline: j.deadline ? j.deadline.slice(0, 10) : '', status: 'saved',
      };
      if (!pass || !loaded) { pending = { type: 'feed', item }; return 'locked'; }
      const r = await save(item);
      if (!r.ok) { flash = ERR[r.error] || ERR.network; return 'error'; }
      await load();
      return 'saved';
    },
    // Öppna formuläret med förifyllda uppgifter (t.ex. från bokmärket i en annan webbläsare)
    openAdd(prefill) {
      const p = prefill || {};
      const t = parseTitle(p.title || '');
      const item = { title: t.title.slice(0, 200), employer: t.employer, location: t.location, url: p.url || '', source: guessSource(p.url || ''), status: 'saved' };
      if (!pass || !loaded) { pending = { type: 'form', item }; return; }
      form = { item }; render();
    },
    mount(el) { host = el; if (pass && !loaded) load(); render(); },
  };
  window.Tracker = api;

  // ---------- gränssnitt ----------
  function render() {
    if (!host) return;
    if (!pass || !loaded) return renderGate();
    renderBoard();
  }

  function renderGate() {
    host.innerHTML = `
      <div class="card">
        <h3 class="qh" style="font-size:18px">📋 Jobbspårare</h3>
        <p class="qsub">Håll koll på jobb du sparat och sökt, med status, sista ansökningsdag, anteckningar och påminnelser. Allt är privat och följer med mellan dina enheter.</p>
        ${flash ? `<div class="gflash">${esc(flash)}</div>` : ''}
        ${loading ? '<div class="empty">Hämtar…</div>' : `
        <form id="tgate" class="gpanel" autocomplete="off" style="border-color:var(--line)">
          <input id="tpass" class="qinput" type="password" placeholder="Lösenord" aria-label="Lösenord" autocomplete="current-password">
          <label class="gremember"><input type="checkbox" id="tkeep" checked> Kom ihåg på den här enheten (du skriver det bara en gång)</label>
          <button class="qbtn primary" type="submit">Lås upp</button>
        </form>`}
      </div>`;
    const f = $('#tgate', host);
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const p = $('#tpass', host).value, keep = $('#tkeep', host).checked;
      $('#tgate button', host).disabled = true;
      const r = await rpc('ma_admin_login', { p_pass: p });
      if (!r.ok) { flash = ERR[r.error] || ERR.network; return renderGate(); }
      remember(p, keep); flash = '';
      await load();
      runPending();
    };
    if (pass && !loaded && !loading) { /* lösenord finns men listan är inte hämtad */ load().then(runPending); }
  }

  async function runPending() {
    if (!pending || !loaded) return;
    const p = pending; pending = null;
    if (p.type === 'feed') { const r = await save(p.item); flash = r.ok ? 'Sparat i spåraren.' : (ERR[r.error] || ERR.network); await load(); }
    else { form = { item: p.item }; render(); }
  }

  function bucket(i) { return ['rejected', 'withdrawn'].includes(i.status) ? 'closed' : i.status; }

  function sorted(list) {
    return [...list].sort((a, b) => (ORDER[a.status] - ORDER[b.status])
      || (a.status === 'saved' ? ((a.deadline ? +new Date(a.deadline) : Infinity) - (b.deadline ? +new Date(b.deadline) : Infinity)) : (+new Date(b.updated_at) - +new Date(a.updated_at))));
  }

  function chip(label, cls) { return `<span class="${cls}">${label}</span>`; }

  function renderCard(i) {
    const dl = i.deadline ? daysTo(i.deadline) : null;
    const fu = i.follow_up ? daysTo(i.follow_up) : null;
    const open = !['rejected', 'withdrawn'].includes(i.status);
    return `<article class="card tcard s-${i.status}">
      <div class="nmeta">
        <b>${esc(i.employer || 'Okänd arbetsgivare')}</b>
        ${i.location ? `<span>${esc(i.location)}</span>` : ''}
        ${i.source ? `<span class="npill">${esc(i.source)}</span>` : ''}
      </div>
      ${i.url ? `<a class="ntitle" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : `<div class="ntitle">${esc(i.title)}</div>`}
      <div class="tchips">
        ${i.deadline && i.status === 'saved' ? chip(`Sista ansökan ${esc(fmt(i.deadline))}${dl >= 0 ? ` (${dl === 0 ? 'idag' : dl === 1 ? 'imorgon' : 'om ' + dl + ' d'})` : ' (passerad)'}`, dl <= 3 ? 'tchip urgent' : 'tchip') : ''}
        ${i.deadline && i.status !== 'saved' ? chip(`Sista ansökan ${esc(fmt(i.deadline))}`, 'tchip') : ''}
        ${i.applied_on ? chip(`Sökt ${esc(fmt(i.applied_on))}`, 'tchip') : ''}
        ${i.follow_up && open ? chip(`Följ upp ${esc(fmt(i.follow_up))}${fu < 0 ? ' (försenad)' : fu === 0 ? ' (idag)' : ''}`, fu <= 0 ? 'tchip urgent' : 'tchip') : ''}
      </div>
      ${i.notes ? `<p class="nsum tnotes">${esc(i.notes.length > 160 ? i.notes.slice(0, 160) + '…' : i.notes)}</p>` : ''}
      <div class="trow">
        <select class="qinput tstatus" data-id="${i.id}" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${i.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <button class="qlink" data-edit="${i.id}">✏️ Ändra</button>
        <button class="qlink danger" data-del="${i.id}">🗑 Ta bort</button>
      </div>
    </article>`;
  }

  function renderBoard() {
    const counts = { all: items.length, saved: 0, applied: 0, interview: 0, offer: 0, closed: 0 };
    items.forEach((i) => { counts[bucket(i)]++; });
    const list = sorted(filter === 'all' ? items : items.filter((i) => bucket(i) === filter));
    const urgent = items.filter((i) => i.status === 'saved' && i.deadline && daysTo(i.deadline) >= 0 && daysTo(i.deadline) <= 3).length;
    host.innerHTML = `
      ${flash ? `<div class="gflash">${esc(flash)}</div>` : ''}
      <div class="tbar">
        <button class="chip active" id="tadd">＋ Lägg till jobb</button>
        <button class="chip" id="tlock">🔒 Lås</button>
      </div>
      ${urgent ? `<div class="gflash" style="border-color:var(--bad)">⏰ ${urgent} sparat${urgent > 1 ? 'e' : ''} jobb har sista ansökningsdag inom 3 dagar.</div>` : ''}
      <div id="tform"></div>
      <div class="qchips" id="tfilters">${GROUPS.map(([k, v]) => `<button class="chip ${filter === k ? 'active' : ''}" data-f="${k}">${v} ${counts[k]}</button>`).join('')}</div>
      <div id="tlist" style="margin-top:12px">${list.length ? list.map(renderCard).join('') : `<div class="empty">${items.length ? 'Inga jobb i den här gruppen.' : 'Inga jobb än. Tryck ⭐ Spara på ett jobb i flödet, eller <b>＋ Lägg till jobb</b> för att lägga in ett från en annan sajt.'}</div>`}</div>
      <div class="card" id="tpush" style="padding:0"></div>
      <div class="card" id="tquick" style="padding:0"></div>`;
    $('#tadd', host).onclick = () => { form = { item: { status: 'saved' } }; flash = ''; render(); };
    $('#tlock', host).onclick = () => { forget(); items = []; loaded = false; flash = ''; form = null; render(); };
    $('#tfilters', host).onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; renderBoard(); } };
    $('#tlist', host).onchange = async (e) => {
      const s = e.target.closest('.tstatus');
      if (!s) return;
      const it = items.find((x) => String(x.id) === s.dataset.id);
      if (!it) return;
      const r = await save({ ...it, status: s.value });
      flash = r.ok ? '' : (ERR[r.error] || ERR.network);
      await load();
    };
    $('#tlist', host).onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
      if (ed) { form = { item: items.find((x) => String(x.id) === ed.dataset.edit) }; flash = ''; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      if (del) {
        const it = items.find((x) => String(x.id) === del.dataset.del);
        if (!it || !confirm(`Ta bort "${it.title}" från spåraren?`)) return;
        const r = await rpc('ma_tracker_delete', { p_pass: pass, p_id: it.id });
        flash = r.ok ? 'Borttaget.' : (ERR[r.error] || ERR.network);
        await load();
      }
    };
    if (form) renderForm();
    renderPush();
    renderQuick();
  }

  // ---------- formulär ----------
  function renderForm() {
    const it = form.item;
    const el = $('#tform', host);
    el.innerHTML = `
      <form id="tf" class="gpanel" autocomplete="off">
        <div class="qlabel" style="margin-top:0">${it.id ? 'Ändra jobb' : 'Lägg till jobb'}</div>
        <div class="tlinkrow">
          <input id="fu" class="qinput" type="url" inputmode="url" placeholder="Länk till annonsen (valfritt)" value="${esc(it.url || '')}" autocapitalize="off" autocorrect="off" spellcheck="false">
          <button class="chip" type="button" id="fpaste">Klistra in</button>
        </div>
        <button class="qbtn ghost" type="button" id="ffetch" style="min-height:40px">🔍 Hämta uppgifter från länken</button>
        <input id="ft" class="qinput" placeholder="Roll *" maxlength="200" value="${esc(it.title || '')}">
        <input id="fe" class="qinput" placeholder="Arbetsgivare" maxlength="120" value="${esc(it.employer || '')}">
        <input id="fl" class="qinput" placeholder="Ort" maxlength="80" value="${esc(it.location || '')}">
        <input id="fs" class="qinput" list="fsrc" placeholder="Var hittade du jobbet?" maxlength="40" value="${esc(it.source || '')}">
        <datalist id="fsrc">${SOURCES.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        <select id="fst" class="qinput">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${(it.status || 'saved') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label class="tlabel">Sista ansökningsdag<input id="fd" class="qinput" type="date" value="${esc(it.deadline || '')}"></label>
        <label class="tlabel">Följ upp den<input id="ff" class="qinput" type="date" value="${esc(it.follow_up || '')}"></label>
        <textarea id="fn" class="qinput" rows="3" maxlength="4000" placeholder="Anteckningar (kontakter, vad du skickade, intervjufrågor…)">${esc(it.notes || '')}</textarea>
        <div class="iqnote" id="fmsg" role="status"></div>
        <button class="qbtn primary" type="submit">Spara</button>
        <button class="qbtn ghost" type="button" id="fcancel">Avbryt</button>
      </form>`;
    const msg = (m) => { $('#fmsg', host).textContent = m; };
    $('#fcancel', host).onclick = () => { form = null; render(); };
    $('#fpaste', host).onclick = async () => {
      try { const t = (await navigator.clipboard.readText()).trim(); if (t) { $('#fu', host).value = t; if (!$('#fs', host).value) $('#fs', host).value = guessSource(t); } else msg('Urklippet är tomt.'); }
      catch { msg('Kunde inte läsa urklippet. Klistra in länken i fältet i stället.'); }
    };
    $('#ffetch', host).onclick = async () => {
      const url = $('#fu', host).value.trim();
      if (!/^https?:\/\//i.test(url)) return msg('Klistra in en länk som börjar med https:// först.');
      const btn = $('#ffetch', host); btn.disabled = true; msg('Hämtar uppgifter…');
      try {
        const res = await fetch(`${C.SUPABASE_URL}/functions/v1/ma-unfurl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass, url }) });
        const j = await res.json();
        if (!j.ok) { msg(j.error === 'forbidden' ? ERR.forbidden : 'Kunde inte läsa länken.'); btn.disabled = false; return; }
        const fill = (id, v) => { const f = $(id, host); if (v && !f.value.trim()) f.value = v; };
        fill('#ft', j.title); fill('#fe', j.employer); fill('#fl', j.location); fill('#fd', j.deadline); fill('#fs', j.source || j.site);
        if (!$('#fs', host).value) $('#fs', host).value = j.site || '';
        msg(j.title || j.employer ? `Hämtade uppgifter från ${j.site}.${j.deadline ? '' : ' Sista ansökningsdag hittades inte, fyll i den själv.'} Kontrollera att det stämmer.` : `Sidan ${j.site} gav inga uppgifter (många sajter kräver inloggning). Fyll i själv.`);
      } catch { msg('Kunde inte nå servern.'); }
      btn.disabled = false;
    };
    $('#tf', host).onsubmit = async (e) => {
      e.preventDefault();
      const v = (id) => $(id, host).value.trim();
      if (!v('#ft')) return msg('Fyll i roll.');
      const item = { id: it.id || '', job_ref: it.job_ref || '', title: v('#ft'), employer: v('#fe'), location: v('#fl'), url: v('#fu'), source: v('#fs'), status: $('#fst', host).value, deadline: v('#fd'), follow_up: v('#ff'), notes: $('#fn', host).value.trim(), applied_on: it.applied_on || '' };
      $('#tf button[type="submit"]', host).disabled = true;
      const r = await save(item);
      if (!r.ok) { msg(ERR[r.error] || ERR.network); $('#tf button[type="submit"]', host).disabled = false; return; }
      form = null; flash = 'Sparat.';
      await load();
    };
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- påminnelser ----------
  async function loadPush() {
    push.loaded = true;
    push.endpoint = await window.PushUtil.currentEndpoint();
    if (push.endpoint) {
      const s = await rpc('ma_tracker_push_get', { p_endpoint: push.endpoint });
      if (s && s.exists) { push.server = s; if (s.days) push.days = s.days; }
    }
    renderPush();
  }

  function renderPush() {
    const el = $('#tpush', host);
    if (!el) return;
    if (!push.loaded) loadPush();
    const on = push.server.exists && push.server.enabled;
    const blocked = window.PushUtil.blockedReason();
    const DAYS = [[7, '7 dagar före'], [3, '3 dagar före'], [1, '1 dag före'], [0, 'Samma dag']];
    el.innerHTML = `
      <button class="nnotehead" id="ptoggle" aria-expanded="${push.open}"><span>🔔 Påminnelser: <b>${on ? 'På' : 'Av'}</b></span><span class="nchev">${push.open ? '▲' : '▼'}</span></button>
      ${push.open ? `<div class="nnotebody">
        <p class="iqnote" style="margin-top:10px">En samlad notis klockan 09 på dagen för sparade jobb som du inte sökt än, och när det är dags att följa upp.</p>
        ${blocked ? `<div class="banner">📲 ${esc(blocked)}</div>` : ''}
        <div class="qlabel">Påminn mig före sista ansökningsdag</div>
        <div class="qchips" id="pdays">${DAYS.map(([d, l]) => `<button class="chip ${push.days.includes(d) ? 'active' : ''}" data-d="${d}">${l}</button>`).join('')}</div>
        <button class="qbtn primary" id="psave" ${blocked || push.busy ? 'disabled' : ''}>${on ? 'Uppdatera' : 'Slå på påminnelser'}</button>
        ${on ? '<button class="qbtn ghost" id="poff">Stäng av påminnelser</button>' : ''}
        <div class="iqnote" role="status">${esc(push.msg)}</div>
      </div>` : ''}`;
    $('#ptoggle', host).onclick = () => { push.open = !push.open; renderPush(); };
    if (!push.open) return;
    $('#pdays', host).onclick = (e) => { const b = e.target.closest('[data-d]'); if (!b) return; const d = Number(b.dataset.d); push.days = push.days.includes(d) ? push.days.filter((x) => x !== d) : [...push.days, d]; push.msg = ''; renderPush(); };
    const save = $('#psave', host), off = $('#poff', host);
    if (save) save.onclick = async () => {
      if (!push.days.length) { push.msg = 'Välj minst en påminnelse.'; return renderPush(); }
      push.busy = true; save.disabled = true;
      try {
        const sub = await window.PushUtil.ensure();
        const j = sub.toJSON();
        const r = await rpc('ma_tracker_push_save', { p_pass: pass, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_days: push.days });
        if (!r.ok) throw new Error(ERR[r.error] || ERR.network);
        push.endpoint = j.endpoint; push.server = { exists: true, enabled: true, days: push.days };
        push.msg = 'Sparat. Du får en notis kl 09 när något närmar sig.';
      } catch (e) { push.msg = e.message === 'blocked' ? 'Notiser är blockerade. Tillåt dem för appen i iPhonens inställningar.' : 'Det gick inte att slå på: ' + e.message; }
      push.busy = false; renderPush();
    };
    if (off) off.onclick = async () => {
      const r = await rpc('ma_tracker_push_delete', { p_endpoint: push.endpoint });
      push.server = { exists: false }; push.msg = r.ok ? 'Påminnelserna är avstängda.' : (ERR[r.error] || ERR.network); renderPush();
    };
  }

  // ---------- snabbspara från andra sajter ----------
  function bookmarklet() {
    const base = location.origin + location.pathname;
    return `javascript:(function(){location.href='${base}?addurl='+encodeURIComponent(location.href)+'&addtitle='+encodeURIComponent(document.title)+'#jobb'})()`;
  }

  function renderQuick() {
    const el = $('#tquick', host);
    if (!el) return;
    const code = bookmarklet();
    el.innerHTML = `
      <button class="nnotehead" id="qtoggle" aria-expanded="${quickOpen}"><span>🔖 Spara jobb från andra sajter snabbt</span><span class="nchev">${quickOpen ? '▲' : '▼'}</span></button>
      ${quickOpen ? `<div class="nnotebody">
        <p class="iqnote" style="margin-top:10px"><b>Enklast:</b> kopiera länken till annonsen, tryck <b>＋ Lägg till jobb</b>, tryck <b>Klistra in</b> och sedan <b>Hämta uppgifter från länken</b>. Appen försöker fylla i roll, arbetsgivare, ort och sista ansökningsdag. På en del sajter, till exempel LinkedIn, går det inte alltid utan inloggning, och då fyller du i resten själv.</p>
        <p class="iqnote"><b>Ett tryck:</b> spara bokmärket nedan i webbläsaren. När du står på en jobbannons trycker du på det, så öppnas appen med länken och rubriken ifylld.</p>
        <div class="jcareerlinks"><a href="${esc(code)}" onclick="return false" draggable="true">Spara i Din Finans App</a></div>
        <button class="qbtn ghost" id="qcopy" style="min-height:40px">Kopiera bokmärkets kod</button>
        <p class="iqnote">Dator: dra knappen ovan till bokmärkesfältet. iPhone (Safari): bokmärk valfri sida, välj <i>Ändra</i> på bokmärket, byt adressen mot den kopierade koden. Använd det sedan från bokmärkena när du står på en annons. En del sajter blockerar bokmärken av säkerhetsskäl. Då fungerar det enklaste sättet ovan.</p>
        <div class="iqnote" id="qmsg" role="status"></div>
      </div>` : ''}`;
    $('#qtoggle', host).onclick = () => { quickOpen = !quickOpen; renderQuick(); };
    const cp = $('#qcopy', host);
    if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(code); $('#qmsg', host).textContent = 'Kopierat.'; } catch { $('#qmsg', host).textContent = 'Kunde inte kopiera. Håll in knappen ovan och välj Kopiera länk.'; } };
  }
})();
