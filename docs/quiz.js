// Förkortnings-quiz: fyra svarsalternativ, de förkortningar du missar kommer tillbaka oftare.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ROUND = 10;
  let ALL = window.Terms.list; // delas med ordlistan och uppdateras när listan ändras
  const CATS = window.QUIZ_CATS;

  // ---------- lagring (bara i den här webbläsaren) ----------
  const KEY = 'quizStats.v1';
  let stats = {};
  try { stats = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const saveStats = () => { try { localStorage.setItem(KEY, JSON.stringify(stats)); } catch {} };
  // box 1 = svår/ny, box 4 = bemästrad. Rätt svar flyttar upp, fel svar tillbaka till 1.
  const st = (a) => stats[a] || { box: 0, right: 0, wrong: 0 };
  const record = (a, ok) => {
    const s = st(a);
    s.box = ok ? Math.min(4, Math.max(1, s.box) + 1) : 1;
    ok ? s.right++ : s.wrong++;
    stats[a] = s;
    saveStats();
  };

  // ---------- urval ----------
  const rand = (n) => Math.floor(Math.random() * n);
  const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const weight = (q) => ({ 0: 3, 1: 4, 2: 2, 3: 1, 4: 0.4 }[st(q.a).box] ?? 3);

  function pickQuestions(pool, n) {
    const left = [...pool];
    const out = [];
    while (out.length < n && left.length) {
      const total = left.reduce((t, q) => t + weight(q), 0);
      let r = Math.random() * total, i = 0;
      for (; i < left.length - 1; i++) { r -= weight(left[i]); if (r <= 0) break; }
      out.push(left.splice(i, 1)[0]);
    }
    return out;
  }

  // Felsvar hämtas från samma kategori och föredrar namn med liknande ord (t.ex. EBIT mot EBITDA).
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-zåäö ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  function options(q) {
    const w = words(q.f);
    let cands = ALL.filter((x) => x.c === q.c && x.f !== q.f);
    if (cands.length < 3) cands = ALL.filter((x) => x.f !== q.f);
    const scored = shuffle(cands).map((x) => ({ x, s: [...words(x.f)].filter((t) => w.has(t)).length }))
      .sort((p, r) => r.s - p.s).slice(0, 7).map((p) => p.x);
    const wrong = shuffle(scored).slice(0, 3);
    return shuffle([q, ...wrong]);
  }

  // ---------- vyer ----------
  const root = () => $('#view-quiz');
  let cat = 'all';
  let mode = 'mixed'; // 'mixed' | 'missed'
  let round = null;
  let qtype = 'choice'; // 'choice' = flerval, 'type' = skriv svaret själv
  try { if (localStorage.getItem('quizType') === 'type') qtype = 'type'; } catch {}

  const poolFor = () => {
    let p = cat === 'all' ? ALL : ALL.filter((q) => q.c === cat);
    if (mode === 'missed') p = p.filter((q) => st(q.a).wrong > 0 && st(q.a).box < 4);
    return p;
  };

  function renderHome() {
    const seen = ALL.filter((q) => st(q.a).box > 0).length;
    const mastered = ALL.filter((q) => st(q.a).box === 4).length;
    const missed = ALL.filter((q) => st(q.a).wrong > 0 && st(q.a).box < 4).length;
    const pool = poolFor().length;
    root().innerHTML = `
      <div class="card">
        <h2 class="qh">Förkortnings-quiz</h2>
        <p class="qsub">Du får en förkortning och ska välja eller skriva rätt betydelse. De du missar kommer tillbaka oftare.</p>
        <div class="qstats">
          <div><b>${seen}</b><span>sedda av ${ALL.length}</span></div>
          <div><b>${mastered}</b><span>bemästrade</span></div>
          <div><b>${missed}</b><span>att repetera</span></div>
        </div>
        <div class="qlabel">Kategori</div>
        <div class="qchips" id="qcats">
          <button class="chip ${cat === 'all' ? 'active' : ''}" data-cat="all">Alla</button>
          ${Object.entries(CATS).map(([id, name]) => `<button class="chip ${cat === id ? 'active' : ''}" data-cat="${id}">${esc(name)}</button>`).join('')}
        </div>
        <div class="qlabel">Läge</div>
        <div class="qchips" id="qmode">
          <button class="chip ${mode === 'mixed' ? 'active' : ''}" data-mode="mixed">Blandat</button>
          <button class="chip ${mode === 'missed' ? 'active' : ''}" data-mode="missed">Bara det jag missat</button>
        </div>
        <div class="qlabel">Svarssätt</div>
        <div class="qchips" id="qtype">
          <button class="chip ${qtype === 'choice' ? 'active' : ''}" data-type="choice">Flerval</button>
          <button class="chip ${qtype === 'type' ? 'active' : ''}" data-type="type">Skriv själv</button>
        </div>
        <button class="qbtn primary" id="qstart" ${pool < 4 ? 'disabled' : ''}>${pool < 4 ? 'För få frågor här än' : `Starta (${Math.min(ROUND, pool)} frågor)`}</button>
        ${seen ? '<button class="qbtn ghost" id="qreset">Nollställ framsteg</button>' : ''}
      </div>`;
    $('#qcats').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) { cat = b.dataset.cat; renderHome(); } };
    $('#qmode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) { mode = b.dataset.mode; renderHome(); } };
    $('#qtype').onclick = (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      qtype = b.dataset.type;
      try { localStorage.setItem('quizType', qtype); } catch {}
      renderHome();
    };
    $('#qstart').onclick = start;
    const reset = $('#qreset');
    if (reset) reset.onclick = () => { if (confirm('Nollställa all quiz-statistik?')) { stats = {}; saveStats(); renderHome(); } };
  }

  function start() {
    const qs = pickQuestions(poolFor(), ROUND);
    round = { qs, i: 0, score: 0, missed: [] };
    renderQuestion();
  }

  // ---------- tolerant jämförelse av skrivna svar ----------
  // Stora/små bokstäver, accenter, bindestreck, skiljetecken och extra mellanslag spelar ingen roll. "&" = "and".
  const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  // Redigeringsavstånd där två omkastade grannbokstäver ("yeild") räknas som ett fel.
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  // 'exact' = rätt, 'close' = godkänt med litet stavfel, 'no' = fel. Små stavfel tillåts på längre svar.
  function grade(input, q) {
    const a = norm(input), b = norm(q.f);
    if (!a) return 'no';
    if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) return 'exact';
    const allowed = b.length >= 16 ? 2 : b.length >= 7 ? 1 : 0;
    return allowed && dist(a, b) <= allowed ? 'close' : 'no';
  }

  function renderQuestion() {
    const q = round.qs[round.i];
    const typed = qtype === 'type';
    const opts = typed ? null : options(q);
    root().innerHTML = `
      <div class="qprog"><span>Fråga ${round.i + 1} av ${round.qs.length}</span><span>${round.score} rätt</span></div>
      <div class="qbar"><i style="width:${(round.i / round.qs.length) * 100}%"></i></div>
      <div class="card qcard">
        <div class="qcat">${esc(CATS[q.c])}</div>
        <div class="qabbr">${esc(q.a)}</div>
        <div class="qask">${typed ? 'Skriv vad det står för' : 'Vad står det för?'}</div>
        ${typed
          ? `<form id="qform" autocomplete="off">
               <input id="qinput" class="qinput" type="text" inputmode="text" enterkeyhint="done"
                 autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Skriv ditt svar…" aria-label="Ditt svar">
               <button class="qbtn primary" id="qsubmit" type="submit">Svara</button>
               <button class="qbtn ghost" id="qskip" type="button">Jag vet inte</button>
             </form>`
          : `<div class="qopts">${opts.map((o, k) => `<button class="qopt" data-k="${k}">${esc(o.f)}</button>`).join('')}</div>`}
        <div id="qfb"></div>
      </div>`;
    if (typed) {
      const input = $('#qinput');
      input.focus();
      $('#qform').onsubmit = (e) => { e.preventDefault(); if (input.disabled) return; finishTyped(q, input.value, false); };
      $('#qskip').onclick = () => { if (!input.disabled) finishTyped(q, '', true); };
    } else {
      root().querySelector('.qopts').onclick = (e) => {
        const b = e.target.closest('.qopt');
        if (!b || b.disabled) return;
        answer(q, opts, Number(b.dataset.k));
      };
    }
  }

  // Flervalsfråga
  function answer(q, opts, k) {
    const ok = opts[k].a === q.a;
    root().querySelectorAll('.qopt').forEach((b, j) => {
      b.disabled = true;
      if (opts[j].a === q.a) b.classList.add('right');
      else if (j === k) b.classList.add('wrong');
    });
    reveal(q, ok, ok ? '' : `<p class="qwrongnote">Du valde: ${esc(opts[k].f)} <span>(${esc(opts[k].a)})</span></p>`);
  }

  // Skriven fråga
  function finishTyped(q, text, skipped) {
    const g = skipped ? 'no' : grade(text, q);
    const input = $('#qinput');
    input.disabled = true;
    $('#qsubmit').hidden = true;
    $('#qskip').hidden = true;
    input.classList.add(g === 'no' ? 'wrong' : 'right');
    const note = g === 'close' ? `<p class="qwrongnote">Nästan! Rätt stavning: <b>${esc(q.f)}</b>. Godkänt.</p>`
      : g === 'no' ? `<p class="qwrongnote">${skipped ? 'Du hoppade över.' : `Du skrev: ${esc(text.trim())}`}</p>` : '';
    reveal(q, g !== 'no', note, g === 'no' && !skipped);
  }

  // Visar facit, sparar resultatet och tar fram "Nästa". canOverride = erbjud "Räkna som rätt" (skrivna svar).
  function reveal(q, ok, note, canOverride = false) {
    const before = JSON.parse(JSON.stringify(st(q.a)));
    record(q.a, ok);
    if (ok) round.score++; else round.missed.push(q);
    const last = round.i + 1 >= round.qs.length;
    $('#qfb').innerHTML = `
      <div class="qfb ${ok ? 'ok' : 'no'}" id="qfbbox">
        <b>${ok ? '✅ Rätt!' : '❌ Fel'}</b>
        <div class="qfull">${esc(q.a)} = ${esc(q.f)}</div>
        <p>${esc(q.s)}</p>
        ${note}
        ${canOverride ? '<button class="qlink" id="qoverride" type="button">Jag hade rätt, räkna som rätt</button>' : ''}
      </div>
      <button class="qbtn primary" id="qnext">${last ? 'Se resultat' : 'Nästa →'}</button>`;
    $('#qnext').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('#qnext').onclick = () => { round.i++; last ? renderResult() : renderQuestion(); };
    const ov = $('#qoverride');
    if (ov) ov.onclick = () => {
      stats[q.a] = before; record(q.a, true); // ångra felet och räkna rätt
      round.missed = round.missed.filter((m) => m.a !== q.a);
      round.score++;
      $('#qfbbox').className = 'qfb ok';
      $('#qfbbox').querySelector('b').textContent = '✅ Räknat som rätt';
      ov.remove();
      document.querySelector('.qprog span:last-child').textContent = `${round.score} rätt`;
    };
  }

  function renderResult() {
    const n = round.qs.length, pct = Math.round((round.score / n) * 100);
    const msg = pct === 100 ? 'Perfekt! 🏆' : pct >= 80 ? 'Mycket bra 💪' : pct >= 50 ? 'Helt okej, öva lite till' : 'Fortsätt öva, det sitter snart';
    root().innerHTML = `
      <div class="card">
        <h2 class="qh">${round.score} av ${n} rätt</h2>
        <p class="qsub">${msg}</p>
        ${round.missed.length ? `<div class="qlabel">Repetera dessa</div>
          ${round.missed.map((q) => `<div class="qmiss"><b>${esc(q.a)}</b> ${esc(q.f)}<span>${esc(q.s)}</span></div>`).join('')}` : ''}
        <button class="qbtn primary" id="qagain">Spela igen</button>
        <button class="qbtn ghost" id="qhome">Till startsidan</button>
      </div>`;
    $('#qagain').onclick = start;
    $('#qhome').onclick = renderHome;
  }

  // Anropas av flikhanteraren (tabs.js) när Quiz-fliken öppnas
  window.onQuizShow = () => { if (!round) renderHome(); };

  // När förkortningar läggs till eller tas bort byter quizet till den nya listan (en pågående omgång påverkas inte).
  window.Terms.subscribe((list) => {
    ALL = list;
    if (!round && !$('#view-quiz').hidden) renderHome();
  });
})();
