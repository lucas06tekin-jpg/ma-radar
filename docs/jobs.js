// Jobb: finansjobb och praktikplatser i Sverige från Arbetsförmedlingens öppna jobbdata, plus verifierade karriärsidor.
// Servern (Supabase) hämtar och klassar annonserna var 30:e minut. Appen läser bara den färdiga listan.
(() => {
  const C = window.CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const root = () => $('#view-jobs');
  const H = { apikey: C.SUPABASE_KEY, Authorization: 'Bearer ' + C.SUPABASE_KEY };
  const rpc = (fn, args) => window.Terms.rpc(fn, args);

  const CATS = { cf: 'Corporate finance & M&A', analys: 'Analys & rådgivning', forvaltning: 'Förvaltning & trading', bank: 'Bank', ekonomi: 'Ekonomi & revision' };
  const LEVELS = { praktik: 'Praktik', trainee: 'Trainee', junior: 'Junior', erfaren: 'Erfaren' };
  const STUDENT = ['praktik', 'trainee', 'junior'];
  const ERR = { invalid: 'Något gick fel när inställningen skulle sparas.', network: 'Kunde inte nå servern. Försök igen.' };

  // Länkar som svarade när jag kontrollerade dem. De stora programmen rekryteras oftast via egna karriärsidor, inte Platsbanken.
  const CAREER = {
    'Banker': [['SEB', 'https://sebgroup.com/career'], ['Nordea', 'https://www.nordea.com/en/careers'], ['Handelsbanken', 'https://www.handelsbanken.se/sv/om-oss/jobba-hos-oss'], ['Swedbank', 'https://www.swedbank.se/om-oss/jobba-hos-oss.html'], ['Danske Bank', 'https://danskebank.com/careers'], ['Carnegie', 'https://www.carnegie.se/karriar/'], ['ABG Sundal Collier', 'https://www.abgsc.com/careers']],
    'Riskkapital & investmentbolag': [['EQT', 'https://eqtgroup.com/about/careers'], ['Altor', 'https://altor.com/careers'], ['Triton', 'https://www.triton-partners.com/careers/'], ['IK Partners', 'https://ikpartners.com/careers/'], ['Latour', 'https://karriar.latour.se/']],
    'Revision & rådgivning': [['PwC', 'https://www.pwc.se/sv/karriar.html'], ['Deloitte', 'https://www.deloitte.com/se/sv/careers.html'], ['EY', 'https://www.ey.com/sv_se/careers'], ['KPMG', 'https://kpmg.com/se/sv/home/karriar.html']],
    'Internationella banker': [['Goldman Sachs', 'https://www.goldmansachs.com/careers/'], ['J.P. Morgan', 'https://careers.jpmorgan.com/'], ['Lazard', 'https://www.lazard.com/careers/'], ['Rothschild & Co', 'https://www.rothschildandco.com/en/careers/']],
    'Myndigheter & jobbsök': [['Riksgälden', 'https://www.riksgalden.se/sv/om-riksgalden/jobba-hos-oss/'], ['Riksbanken', 'https://www.riksbank.se/sv/om-riksbanken/jobba-hos-oss/'], ['Platsbanken', 'https://arbetsformedlingen.se/platsbanken/']],
  };

  let items = [];
  let loaded = false;
  let built = false;
  const f = { level: 'stud', cat: 'all', region: '', sort: 'new' };
  const note = { loaded: false, busy: false, endpoint: null, server: { exists: false }, levels: STUDENT.slice(), cats: Object.keys(CATS), region: '', msg: '', open: false };
  let careerOpen = false;

  const ago = (d) => {
    const m = Math.max(1, Math.round((Date.now() - new Date(d)) / 60000));
    return m < 60 ? `${m} min sedan` : m < 1440 ? `${Math.round(m / 60)} h sedan` : `${Math.round(m / 1440)} d sedan`;
  };
  const fmtDate = (d) => new Date(d).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  const daysLeft = (d) => Math.ceil((new Date(d) - Date.now()) / 864e5);

  // ---------- jobblistan ----------
  async function loadItems() {
    try {
      const r = await fetch(`${C.SUPABASE_URL}/rest/v1/ma_jobs?select=id,headline,employer,municipality,region,published,deadline,url,apply_url,category,level,occupation,snippet&order=published.desc&limit=600`, { headers: H });
      if (r.ok) { items = await r.json(); loaded = true; }
    } catch {}
    fillRegions();
    renderList();
  }

  function fillRegions() {
    const sel = $('#jregion');
    if (!sel) return;
    const count = {};
    items.forEach((j) => { if (j.region) count[j.region] = (count[j.region] || 0) + 1; });
    const regs = Object.entries(count).sort((a, b) => b[1] - a[1]).map(([r]) => r);
    const opts = (cur) => '<option value="">Hela Sverige</option>' + regs.map((r) => `<option value="${esc(r)}" ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('');
    sel.innerHTML = opts(f.region);
    const nsel = $('#jnregion');
    if (nsel) nsel.innerHTML = opts(note.region);
  }

  function visible() {
    let list = items.filter((j) => !j.deadline || new Date(j.deadline) > new Date());
    if (f.level === 'stud') list = list.filter((j) => STUDENT.includes(j.level));
    else if (f.level !== 'all') list = list.filter((j) => j.level === f.level);
    if (f.cat !== 'all') list = list.filter((j) => j.category === f.cat);
    if (f.region) list = list.filter((j) => j.region === f.region);
    if (f.sort === 'deadline') list = [...list].sort((a, b) => (a.deadline ? +new Date(a.deadline) : Infinity) - (b.deadline ? +new Date(b.deadline) : Infinity));
    return list;
  }

  function renderList() {
    const el = $('#jlist');
    if (!el) return;
    if (!loaded) { el.innerHTML = '<div class="empty">Laddar jobb…</div>'; return; }
    const list = visible();
    $('#jcount').textContent = `${list.length} jobb`;
    el.innerHTML = list.length ? list.map((j) => {
      const dl = j.deadline ? daysLeft(j.deadline) : null;
      const fresh = Date.now() - new Date(j.published) < 24 * 3600e3;
      return `<article class="card ncard">
        <div class="nmeta">
          <b>${esc(j.employer || 'Okänd arbetsgivare')}</b>
          ${j.municipality ? `<span>${esc(j.municipality)}</span>` : ''}
          <span>${esc(ago(j.published))}</span>
          ${fresh ? '<span class="npill big">Ny</span>' : ''}
          <span class="npill ${j.level === 'erfaren' ? '' : 'imp'}">${esc(LEVELS[j.level])}</span>
        </div>
        <a class="ntitle" href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.headline)}</a>
        ${j.snippet ? `<p class="nsum">${esc(j.snippet.length > 180 ? j.snippet.slice(0, 180) + '…' : j.snippet)}</p>` : ''}
        <div class="ntags"><span>${esc(CATS[j.category])}</span>${j.occupation ? `<span>${esc(j.occupation)}</span>` : ''}
          ${j.deadline ? `<span class="${dl <= 7 ? 'jurgent' : ''}">Sista ansökan ${esc(fmtDate(j.deadline))}${dl >= 0 ? ` (${dl === 0 ? 'idag' : dl === 1 ? 'imorgon' : 'om ' + dl + ' d'})` : ''}</span>` : ''}</div>
        <div class="jlinks"><a href="${esc(j.url)}" target="_blank" rel="noopener">Öppna annons →</a>${j.apply_url ? `<a href="${esc(j.apply_url)}" target="_blank" rel="noopener">Ansök hos arbetsgivaren →</a>` : ''}</div>
      </article>`;
    }).join('')
      : `<div class="empty">Inga jobb i det här urvalet.${f.level === 'stud' ? ' De flesta annonser kräver erfarenhet, så prova <b>Alla nivåer</b> eller en annan region.' : ''}</div>`;
  }

  // ---------- notiser ----------
  async function loadNoteState() {
    note.loaded = true;
    note.endpoint = await window.PushUtil.currentEndpoint();
    if (note.endpoint) {
      const s = await rpc('ma_jobs_sub_get', { p_endpoint: note.endpoint });
      if (s && s.exists) { note.server = s; note.levels = s.levels; note.cats = s.categories; note.region = s.region || ''; }
    }
    renderNote();
  }

  const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  function renderNote() {
    const el = $('#jnote');
    if (!el) return;
    const on = note.server.exists && note.server.enabled;
    const blocked = window.PushUtil.blockedReason();
    el.innerHTML = `
      <button class="nnotehead" id="jtoggle" aria-expanded="${note.open}">
        <span>🔔 Jobbnotiser: <b>${on ? 'På' : 'Av'}</b></span><span class="nchev">${note.open ? '▲' : '▼'}</span>
      </button>
      ${note.open ? `
        <div class="nnotebody">
          ${blocked ? `<div class="banner">📲 ${esc(blocked)}</div>` : ''}
          <div class="qlabel">Nivå</div>
          <div class="qchips" id="jnlevels">${Object.entries(LEVELS).map(([k, v]) => `<button class="chip ${note.levels.includes(k) ? 'active' : ''}" data-l="${k}">${v}</button>`).join('')}</div>
          <div class="qlabel">Område</div>
          <div class="qchips" id="jncats">${Object.entries(CATS).map(([k, v]) => `<button class="chip ${note.cats.includes(k) ? 'active' : ''}" data-c="${k}">${v}</button>`).join('')}</div>
          <div class="qlabel">Region</div>
          <select id="jnregion" class="qinput"></select>
          <button class="qbtn primary" id="jnsave" ${blocked || note.busy ? 'disabled' : ''}>${on ? 'Uppdatera' : 'Slå på jobbnotiser'}</button>
          ${on ? '<button class="qbtn ghost" id="jnoff">Stäng av jobbnotiser</button>' : ''}
          <div class="iqnote" id="jnmsg" role="status">${esc(note.msg)}</div>
        </div>` : ''}`;
    $('#jtoggle').onclick = () => { note.open = !note.open; if (note.open && !note.loaded) loadNoteState(); renderNote(); fillRegions(); };
    if (!note.open) return;
    fillRegions();
    $('#jnlevels').onclick = (e) => { const b = e.target.closest('[data-l]'); if (b) { note.levels = toggleIn(note.levels, b.dataset.l); note.msg = ''; renderNote(); } };
    $('#jncats').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { note.cats = toggleIn(note.cats, b.dataset.c); note.msg = ''; renderNote(); } };
    $('#jnregion').onchange = (e) => { note.region = e.target.value; };
    const save = $('#jnsave'), off = $('#jnoff');
    if (save) save.onclick = doSave;
    if (off) off.onclick = doOff;
  }

  async function doSave() {
    if (!note.levels.length || !note.cats.length) { note.msg = 'Välj minst en nivå och ett område.'; return renderNote(); }
    note.busy = true; $('#jnsave').disabled = true;
    try {
      const sub = await window.PushUtil.ensure(); // måste ske direkt från knapptrycket
      const j = sub.toJSON();
      const r = await rpc('ma_jobs_sub_save', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_levels: note.levels, p_categories: note.cats, p_region: note.region });
      if (!r.ok) throw new Error(ERR[r.error] || ERR.network);
      note.endpoint = j.endpoint;
      note.server = { exists: true, enabled: true };
      note.msg = 'Sparat. Du får en notis när ett nytt jobb matchar.';
    } catch (e) {
      note.msg = e.message === 'blocked' ? 'Notiser är blockerade. Tillåt dem för appen i iPhonens inställningar.' : 'Det gick inte att slå på notiser: ' + e.message;
    }
    note.busy = false;
    renderNote();
  }

  async function doOff() {
    note.busy = true;
    const r = await rpc('ma_jobs_sub_delete', { p_endpoint: note.endpoint });
    note.busy = false;
    if (r.ok) { note.server = { exists: false }; note.msg = 'Jobbnotiserna är avstängda.'; } else note.msg = ERR[r.error] || ERR.network;
    renderNote();
  }

  // ---------- karriärsidor ----------
  function renderCareer() {
    const el = $('#jcareer');
    if (!el) return;
    el.innerHTML = `
      <button class="nnotehead" id="jctoggle" aria-expanded="${careerOpen}"><span>🎯 Karriärsidor: banker, riskkapital, myndigheter</span><span class="nchev">${careerOpen ? '▲' : '▼'}</span></button>
      ${careerOpen ? `<div class="nnotebody">
        <p class="iqnote" style="margin-top:10px">De stora trainee- och praktikprogrammen rekryteras oftast via bolagens egna sidor och dyker sällan upp i Platsbanken. Länkarna fungerade när jag kontrollerade dem.</p>
        ${Object.entries(CAREER).map(([g, ls]) => `<div class="qlabel">${esc(g)}</div><div class="jcareerlinks">${ls.map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`).join('')}</div>`).join('')}
      </div>` : ''}`;
    $('#jctoggle').onclick = () => { careerOpen = !careerOpen; renderCareer(); };
  }

  // ---------- uppbyggnad ----------
  function build() {
    root().innerHTML = `
      <div class="card" id="jnote" style="padding:0"></div>
      <div class="card" id="jcareer" style="padding:0"></div>
      <div class="qlabel">Nivå</div>
      <div class="qchips" id="jlevel">
        <button class="chip active" data-v="stud">För studenter</button>
        <button class="chip" data-v="praktik">Praktik</button>
        <button class="chip" data-v="trainee">Trainee</button>
        <button class="chip" data-v="junior">Junior</button>
        <button class="chip" data-v="all">Alla nivåer</button>
      </div>
      <div class="qlabel">Område</div>
      <div class="qchips" id="jcat">
        <button class="chip active" data-v="all">Alla</button>
        ${Object.entries(CATS).map(([k, v]) => `<button class="chip" data-v="${k}">${v}</button>`).join('')}
      </div>
      <div class="jrow"><select id="jregion" class="qinput" aria-label="Region"></select>
        <select id="jsort" class="qinput" aria-label="Sortera"><option value="new">Nyast först</option><option value="deadline">Sista ansökan först</option></select></div>
      <div class="gcount" id="jcount" style="margin:8px 0 6px"></div>
      <div id="jlist"></div>
      <p class="iqnote">Annonserna kommer från Arbetsförmedlingens öppna jobbdata. Nivå (praktik, trainee, junior) och område gissas av appen utifrån rubrik och beskrivning, så dubbelkolla alltid i annonsen. Alla jobb visas oavsett om du är student eller inte, och utländska arbetsgivare och direktrekryteringar syns inte här.</p>`;
    const chips = (id, key) => { $(id).onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; f[key] = b.dataset.v; document.querySelectorAll(id + ' .chip').forEach((c) => c.classList.toggle('active', c === b)); renderList(); }; };
    chips('#jlevel', 'level'); chips('#jcat', 'cat');
    $('#jregion').onchange = (e) => { f.region = e.target.value; renderList(); };
    $('#jsort').onchange = (e) => { f.sort = e.target.value; renderList(); };
    renderNote(); renderCareer(); fillRegions(); renderList();
  }

  let timer = null;
  window.onJobsShow = () => {
    if (!built) { built = true; build(); }
    loadItems();
    if (!note.loaded) loadNoteState();
    clearInterval(timer);
    timer = setInterval(() => { if (!root().hidden) loadItems(); else clearInterval(timer); }, 5 * 60000);
  };
})();
