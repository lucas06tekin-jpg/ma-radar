// Ordlista: sök och bläddra bland alla förkortningar (samma data som quizet).
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CATS = window.QUIZ_CATS;
  const ALL = window.QUIZ_DATA.map(([a, f, s, c]) => ({ a, f, s, c }));

  // Sökning ignorerar versaler, accenter och tecken som / & - (så "pe" hittar både P/E och PE).
  const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  ALL.forEach((x) => { x.na = norm(x.a); x.nf = norm(x.f); x.ns = norm(x.s); });

  let cat = 'all';
  let query = '';
  let built = false;

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

  function render() {
    const q = norm(query);
    let hits = ALL.filter((x) => cat === 'all' || x.c === cat)
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
        <div class="ghead"><b class="gabbr">${esc(x.a)}</b><span class="gcat">${esc(CATS[x.c])}</span></div>
        <div class="gfull">${esc(x.f)}</div>
        <p class="gexp">${esc(x.s)}</p>
      </div>`;
    }
    $('#gcount').textContent = `${hits.length} av ${ALL.length} förkortningar`;
    $('#glist').innerHTML = html || '<div class="empty">Inga träffar. Prova en annan stavning eller kategori.</div>';
  }

  function build() {
    $('#view-glossary').innerHTML = `
      <input id="gsearch" class="qinput" type="search" placeholder="Sök förkortning eller begrepp…" aria-label="Sök i ordlistan"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      <div class="qchips gchips" id="gcats">
        <button class="chip active" data-cat="all">Alla</button>
        ${Object.entries(CATS).map(([id, name]) => `<button class="chip" data-cat="${id}">${esc(name)}</button>`).join('')}
      </div>
      <div class="gcount" id="gcount"></div>
      <div id="glist"></div>`;
    $('#gsearch').addEventListener('input', (e) => { query = e.target.value; render(); });
    $('#gcats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      cat = b.dataset.cat;
      document.querySelectorAll('#gcats .chip').forEach((c) => c.classList.toggle('active', c === b));
      render();
    });
    render();
  }

  // Anropas av flikhanteraren (tabs.js) när Ordlista-fliken öppnas
  window.onGlossaryShow = () => { if (!built) { built = true; build(); } };
})();
