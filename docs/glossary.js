// Ordlista: sök och bläddra bland alla förkortningar. Delar data med quizet via window.Terms.
// Redigeringsläget (lägga till/ta bort) kräver lösenord och kontrolleras i databasen.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CATS = window.QUIZ_CATS;

  // Sökning ignorerar versaler, accenter och tecken som / & - (så "pe" hittar både P/E och PE).
  const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  let ALL = [];
  const setAll = (list) => { ALL = list.map((x) => ({ ...x, na: norm(x.a), nf: norm(x.f), ns: norm(x.s) })); };
  setAll(window.Terms.list);

  let cat = 'all';
  let query = '';
  let built = false;

  // ---------- redigeringsläge ----------
  const PASS_KEY = 'ma.admin';
  let pass = null; // lösenordet hålls i minnet och sparas bara om man väljer "Kom ihåg"
  try { pass = sessionStorage.getItem(PASS_KEY) || localStorage.getItem(PASS_KEY) || null; } catch {}
  let panel = null; // null | 'login' | { edit: term | null }
  let flash = '';

  const ERR = {
    forbidden: 'Fel lösenord.',
    locked: 'För många felaktiga försök. Vänta 15 minuter.',
    not_configured: 'Lösenordet är inte inställt än.',
    invalid: 'Kontrollera fälten. Alla måste vara ifyllda och inte för långa.',
    network: 'Kunde inte nå servern. Försök igen.',
  };
  const forget = () => { pass = null; try { sessionStorage.removeItem(PASS_KEY); localStorage.removeItem(PASS_KEY); } catch {} };
  const remember = (p, persist) => {
    pass = p;
    try { (persist ? localStorage : sessionStorage).setItem(PASS_KEY, p); } catch {}
  };

  // ---------- sökning ----------
  // Lägre poäng = bättre träff. null = ingen träff.
  function score(x, q) {
    if (!q) return 0;
    if (x.na === q) return 0;
    if (x.na.startsWith(q)) return 1;
    if (x.nf.split(' ').some((w) => w.startsWith(q)) || x.nf.startsWith(q)) return 2;
    // Korta sökord (1-2 tecken) söker bara i förkortning och engelskt namn, annars blir det brus som "pe" i "per".
    if (q.length < 3) return null;
    if (x.na.includes(q) || x.nf.includes(q)) return 3;
    if (x.ns.includes(q)) return 4;
    return null;
  }

  const letterOf = (a) => { const c = a[0].toUpperCase(); return /\p{L}/u.test(c) ? c : '#'; };

  function renderList() {
    const q = norm(query);
    const hits = ALL.filter((x) => cat === 'all' || x.c === cat)
      .map((x) => ({ x, s: score(x, q) })).filter((h) => h.s !== null);
    // Sorterar på träffkvalitet vid sökning, annars alfabetiskt.
    hits.sort((p, r) => (q ? p.s - r.s : 0) || p.x.a.localeCompare(r.x.a, 'sv', { sensitivity: 'base' }));

    let html = '';
    let lastLetter = '';
    for (const { x } of hits) {
      if (!q) {
        const l = letterOf(x.a);
        if (l !== lastLetter) { html += `<div class="gletter">${esc(l)}</div>`; lastLetter = l; }
      }
      html += `<div class="gitem">
        <div class="ghead"><b class="gabbr">${esc(x.a)}</b><span class="gcat">${esc(CATS[x.c] || '')}</span></div>
        <div class="gfull">${esc(x.f)}</div>
        <p class="gexp">${esc(x.s)}</p>
        ${pass ? `<div class="gtools"><button class="qlink" data-edit="${esc(x.a)}">Ändra</button><button class="qlink danger" data-del="${esc(x.a)}">Ta bort</button></div>` : ''}
      </div>`;
    }
    $('#gcount').textContent = `${hits.length} av ${ALL.length} förkortningar`;
    $('#glist').innerHTML = html || '<div class="empty">Inga träffar. Prova en annan stavning eller kategori.</div>';
  }

  // ---------- panel högst upp: inloggning eller redigering ----------
  function renderTools() {
    const el = $('#gtools');
    const msg = flash ? `<div class="gflash">${esc(flash)}</div>` : '';
    if (panel === 'login') {
      el.innerHTML = `${msg}<form id="gloginform" class="gpanel" autocomplete="off">
        <div class="qlabel" style="margin-top:0">Lås upp redigering</div>
        <input id="gpass" class="qinput" type="password" placeholder="Lösenord" aria-label="Lösenord" autocomplete="current-password">
        <label class="gremember"><input type="checkbox" id="gkeep"> Kom ihåg på den här enheten</label>
        <button class="qbtn primary" type="submit">Lås upp</button>
        <button class="qbtn ghost" type="button" id="gcancel">Avbryt</button>
      </form>`;
      $('#gpass').focus();
      $('#gcancel').onclick = () => { panel = null; flash = ''; renderTools(); };
      $('#gloginform').onsubmit = async (e) => {
        e.preventDefault();
        const p = $('#gpass').value;
        const keep = $('#gkeep').checked;
        const r = await window.Terms.login(p);
        if (r.ok) { remember(p, keep); panel = null; flash = ''; renderTools(); renderList(); }
        else { flash = ERR[r.error] || ERR.network; renderTools(); }
      };
      return;
    }
    if (panel && typeof panel === 'object') {
      const t = panel.edit || { a: '', f: '', s: '', c: cat === 'all' ? 'res' : cat };
      el.innerHTML = `${msg}<form id="gedit" class="gpanel" autocomplete="off">
        <div class="qlabel" style="margin-top:0">${panel.edit ? 'Ändra förkortning' : 'Lägg till förkortning'}</div>
        <input id="fa" class="qinput" placeholder="Förkortning, t.ex. EBITDA" maxlength="24" value="${esc(t.a)}" ${panel.edit ? 'readonly' : ''} autocapitalize="off" autocorrect="off" spellcheck="false">
        <input id="ff" class="qinput" placeholder="Vad den står för (engelska), t.ex. Cost of Goods Sold" maxlength="200" value="${esc(t.f)}" autocapitalize="sentences" spellcheck="false">
        <textarea id="fs" class="qinput" rows="3" placeholder="Förklaring på svenska" maxlength="600">${esc(t.s)}</textarea>
        <select id="fc" class="qinput">${Object.entries(CATS).map(([id, name]) => `<option value="${id}" ${t.c === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>
        <button class="qbtn primary" type="submit">Spara</button>
        <button class="qbtn ghost" type="button" id="gcancel">Avbryt</button>
      </form>`;
      (panel.edit ? $('#ff') : $('#fa')).focus();
      $('#gcancel').onclick = () => { panel = null; flash = ''; renderTools(); };
      $('#gedit').onsubmit = async (e) => {
        e.preventDefault();
        const term = { a: $('#fa').value.trim(), f: $('#ff').value.trim(), s: $('#fs').value.trim(), c: $('#fc').value };
        if (!term.a || !term.f || !term.s) { flash = ERR.invalid; renderTools(); return; }
        const r = await window.Terms.save(pass, term);
        if (r.ok) { flash = `Sparat: ${term.a}`; panel = null; setAll(window.Terms.list); renderTools(); renderList(); }
        else { if (r.error === 'forbidden') forget(); flash = ERR[r.error] || ERR.network; if (!pass) panel = null; renderTools(); renderList(); }
      };
      return;
    }
    el.innerHTML = `${msg}<div class="gbar">${pass
      ? `<button class="chip active" id="gadd">＋ Lägg till</button><button class="chip" id="glock">Lås</button>`
      : `<button class="chip" id="gunlock">Redigera</button>`}</div>`;
    if (pass) {
      $('#gadd').onclick = () => { panel = { edit: null }; flash = ''; renderTools(); };
      $('#glock').onclick = () => { forget(); flash = ''; renderTools(); renderList(); };
    } else {
      $('#gunlock').onclick = () => { panel = 'login'; flash = ''; renderTools(); };
    }
  }

  // ---------- uppbyggnad ----------
  function build() {
    $('#view-glossary').innerHTML = `
      <input id="gsearch" class="qinput" type="search" placeholder="Sök förkortning eller begrepp…" aria-label="Sök i ordlistan"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      <div class="qchips gchips" id="gcats">
        <button class="chip active" data-cat="all">Alla</button>
        ${Object.entries(CATS).map(([id, name]) => `<button class="chip" data-cat="${id}">${esc(name)}</button>`).join('')}
      </div>
      <div class="grow"><span class="gcount" id="gcount"></span></div>
      <div id="gtools"></div>
      <div id="glist"></div>`;
    $('#gsearch').addEventListener('input', (e) => { query = e.target.value; renderList(); });
    $('#gcats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      cat = b.dataset.cat;
      document.querySelectorAll('#gcats .chip').forEach((c) => c.classList.toggle('active', c === b));
      renderList();
    });
    $('#glist').addEventListener('click', async (e) => {
      const ed = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (ed) {
        panel = { edit: ALL.find((x) => x.a === ed.dataset.edit) };
        flash = '';
        renderTools();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (del) {
        const abbr = del.dataset.del;
        if (!confirm(`Ta bort ${abbr}? Det försvinner från både ordlistan och quizet.`)) return;
        const r = await window.Terms.remove(pass, abbr);
        if (r.ok) flash = `Borttaget: ${abbr}`;
        else { if (r.error === 'forbidden') forget(); flash = ERR[r.error] || ERR.network; }
        setAll(window.Terms.list);
        renderTools();
        renderList();
      }
    });
    renderTools();
    renderList();
  }

  // Anropas av flikhanteraren (tabs.js) när Ordlista-fliken öppnas
  window.onGlossaryShow = () => { if (!built) { built = true; build(); } };

  // Håller ordlistan i takt med databasen (och quizet, som lyssnar på samma källa).
  window.Terms.subscribe((list) => { setAll(list); if (built) renderList(); });
})();
