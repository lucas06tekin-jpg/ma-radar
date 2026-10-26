// Intervjuträning: svara på frågor i egna ord, jämför med facit och betygsätt dig själv.
// Frågorna och facit är privata och hämtas bara med lösenordet. De finns inte i appens kod.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const root = () => $('#view-interview');
  const ROUND = 10;
  const GROUPS = { fit: 'Personliga frågor', deal: 'Affärer & restructuring', tech: 'Tekniska frågor', brain: 'Hjärngympa' };
  const RATE = { missed: '😕 Missade', partial: '🙂 Delvis', nailed: '✅ Klarade' };

  const PASS_KEY = 'ma.admin'; // samma lösenord och samma "kom ihåg" som i ordlistans redigeringsläge
  let pass = null;
  try { pass = sessionStorage.getItem(PASS_KEY) || localStorage.getItem(PASS_KEY) || null; } catch {}
  const forget = () => { pass = null; try { sessionStorage.removeItem(PASS_KEY); localStorage.removeItem(PASS_KEY); } catch {} };
  const remember = (p, persist) => { pass = p; try { (persist ? localStorage : sessionStorage).setItem(PASS_KEY, p); } catch {} };

  const ERR = {
    forbidden: 'Fel lösenord.',
    locked: 'För många felaktiga försök. Vänta 15 minuter.',
    not_configured: 'Lösenordet är inte inställt än.',
    invalid: 'Något gick fel när svaret skulle sparas.',
    network: 'Kunde inte nå servern. Försök igen.',
  };

  let Q = [];            // alla frågor (hålls bara i minnet)
  let prog = new Map();  // qid -> { answer, rating, attempts }
  let loaded = false;
  let loading = false;
  let grp = 'all';
  let mode = 'mix';      // mix | new | hard
  let round = null;      // { qs, i, results: {qid: rating}, draft, revealed, rated }
  let view = renderGate;
  let flash = '';

  // ---------- hjälpare ----------
  const rand = (n) => Math.floor(Math.random() * n);
  const weight = (q) => {
    const p = prog.get(q.id);
    if (!p || !p.rating) return 3;
    return { missed: 4, partial: 2.5, nailed: 0.5 }[p.rating] ?? 3;
  };
  function pool() {
    let p = grp === 'all' ? Q : Q.filter((q) => q.grp === grp);
    if (mode === 'new') p = p.filter((q) => !prog.get(q.id)?.rating);
    if (mode === 'hard') p = p.filter((q) => ['missed', 'partial'].includes(prog.get(q.id)?.rating));
    return p;
  }
  function pick(p, n) {
    const left = [...p], out = [];
    while (out.length < n && left.length) {
      const total = left.reduce((t, q) => t + weight(q), 0);
      let r = Math.random() * total, i = 0;
      for (; i < left.length - 1; i++) { r -= weight(left[i]); if (r <= 0) break; }
      out.push(left.splice(i, 1)[0]);
    }
    return out;
  }
  const paras = (t) => String(t).split(/\n{2,}/).map((x) => `<p>${esc(x.trim())}</p>`).join('');

  // ---------- låsskärm ----------
  function renderGate() {
    view = renderGate;
    root().innerHTML = `
      <div class="card">
        <h2 class="qh">Intervjuträning</h2>
        <p class="qsub">Öva på intervjufrågor för investment banking. Du svarar med egna ord, ser facit och betygsätter dig själv. Innehållet ur boken är privat, så första gången på en enhet behövs lösenordet.</p>
        ${flash ? `<div class="gflash">${esc(flash)}</div>` : ''}
        <form id="igate" class="gpanel" autocomplete="off" style="border-color:var(--line)">
          <input id="ipass" class="qinput" type="password" placeholder="Lösenord" aria-label="Lösenord" autocomplete="current-password">
          <label class="gremember"><input type="checkbox" id="ikeep" checked> Kom ihåg på den här enheten (du skriver det bara en gång)</label>
          <button class="qbtn primary" type="submit">Lås upp</button>
        </form>
      </div>`;
    $('#igate').onsubmit = async (e) => {
      e.preventDefault();
      const p = $('#ipass').value, keep = $('#ikeep').checked;
      $('#igate button').disabled = true;
      await load(p, keep);
    };
  }

  async function load(p, keep) {
    if (loading) return;
    loading = true;
    root().innerHTML = '<div class="empty">Hämtar frågor…</div>';
    const r = await window.Terms.rpc('ma_iq_load', { p_pass: p });
    loading = false;
    if (!r.ok) {
      if (r.error === 'forbidden') forget();
      flash = ERR[r.error] || ERR.network;
      return renderGate();
    }
    if (p !== pass) remember(p, keep);
    Q = r.questions;
    prog = new Map(r.progress.map((x) => [x.qid, x]));
    loaded = true;
    flash = '';
    renderHome();
  }

  // ---------- startsida ----------
  function renderHome() {
    view = renderHome;
    const answered = [...prog.values()].filter((p) => p.rating).length;
    const nailed = [...prog.values()].filter((p) => p.rating === 'nailed').length;
    const hard = [...prog.values()].filter((p) => ['missed', 'partial'].includes(p.rating)).length;
    const n = pool().length;
    root().innerHTML = `
      <div class="card">
        <h2 class="qh">Intervjuträning</h2>
        <p class="qsub">Skriv ditt svar, titta på facit och betygsätt dig själv. Det du missar kommer tillbaka oftare.</p>
        <div class="qstats">
          <div><b>${answered}</b><span>besvarade av ${Q.length}</span></div>
          <div><b>${nailed}</b><span>klarade</span></div>
          <div><b>${hard}</b><span>att öva mer på</span></div>
        </div>
        <div class="qlabel">Område</div>
        <div class="qchips" id="igrp">
          <button class="chip ${grp === 'all' ? 'active' : ''}" data-g="all">Alla</button>
          ${Object.entries(GROUPS).map(([id, name]) => `<button class="chip ${grp === id ? 'active' : ''}" data-g="${id}">${esc(name)}</button>`).join('')}
        </div>
        <div class="qlabel">Urval</div>
        <div class="qchips" id="imode">
          <button class="chip ${mode === 'mix' ? 'active' : ''}" data-m="mix">Blandat</button>
          <button class="chip ${mode === 'new' ? 'active' : ''}" data-m="new">Nya frågor</button>
          <button class="chip ${mode === 'hard' ? 'active' : ''}" data-m="hard">Det jag missat</button>
        </div>
        <button class="qbtn primary" id="istart" ${n < 1 ? 'disabled' : ''}>${n < 1 ? 'Inga frågor i det här urvalet' : `Starta (${Math.min(ROUND, n)} frågor)`}</button>
        <button class="qbtn ghost" id="ilock">🔒 Lås</button>
        <p class="iqnote">Frågor och facit är hämtade ur din egen kopia av boken och sparas inte på den här enheten. Dina svar sparas på ditt konto så att de följer med mellan enheter.</p>
      </div>`;
    $('#igrp').onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { grp = b.dataset.g; renderHome(); } };
    $('#imode').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { mode = b.dataset.m; renderHome(); } };
    $('#istart').onclick = start;
    $('#ilock').onclick = () => { forget(); Q = []; prog = new Map(); loaded = false; round = null; flash = ''; renderGate(); };
  }

  function start() {
    const qs = pick(pool(), ROUND);
    round = { qs, i: 0, results: {}, draft: '', revealed: false, rated: null };
    renderQuestion();
  }

  // ---------- fråga ----------
  function renderQuestion() {
    view = renderQuestion;
    const q = round.qs[round.i];
    const prev = prog.get(q.id);
    const last = round.i + 1 >= round.qs.length;
    root().innerHTML = `
      <div class="qprog"><span>Fråga ${round.i + 1} av ${round.qs.length}</span><span>${Object.keys(round.results).length} betygsatta</span></div>
      <div class="qbar"><i style="width:${(round.i / round.qs.length) * 100}%"></i></div>
      <div class="card qcard" style="padding:14px">
        <div class="iqsec">${esc(GROUPS[q.grp])} · ${esc(q.section)} · fråga ${q.n}</div>
        <div class="iqq">${esc(q.q)}</div>
        ${prev && prev.rating ? `<p class="iqprev">Förra gången: ${esc(RATE[prev.rating])}${prev.answer ? ' · du svarade: ' + esc(prev.answer.length > 160 ? prev.answer.slice(0, 160) + '…' : prev.answer) : ''}</p>` : ''}
        <textarea id="ians" class="qinput iqarea" placeholder="Skriv ditt svar här, som om du svarade i intervjun…" maxlength="8000"
          autocapitalize="sentences" spellcheck="false" ${round.revealed ? 'readonly' : ''}>${esc(round.draft)}</textarea>
        <div id="iactions"></div>
      </div>`;
    $('#ians').addEventListener('input', (e) => { round.draft = e.target.value; });
    renderActions(q, last);
    if (!round.revealed) $('#ians').focus();
  }

  function renderActions(q, last) {
    const el = $('#iactions');
    if (!round.revealed) {
      el.innerHTML = `<button class="qbtn primary" id="ireveal">Visa facit</button><button class="qbtn ghost" id="iskip">Hoppa över</button>`;
      $('#ireveal').onclick = () => { round.revealed = true; renderQuestion(); $('#ibook')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
      $('#iskip').onclick = () => advance(last);
      return;
    }
    el.innerHTML = `
      <div class="iqblock book" id="ibook"><h4>Facit ur boken</h4>${paras(q.a)}</div>
      <div class="qlabel">Hur gick det?</div>
      <div class="iqrate">${Object.entries(RATE).map(([k, v]) => `<button data-r="${k}" class="${round.rated === k ? 'picked' : ''}" ${round.rated ? 'disabled' : ''}>${esc(v)}</button>`).join('')}</div>
      <div id="isaveMsg" class="iqnote"></div>
      ${round.rated ? `<button class="qbtn primary" id="inext">${last ? 'Se resultat' : 'Nästa →'}</button>` : ''}`;
    $('#ibook').scrollIntoView({ block: 'nearest' });
    el.querySelector('.iqrate').onclick = async (e) => {
      const b = e.target.closest('[data-r]');
      if (!b || round.rated) return;
      const rating = b.dataset.r;
      el.querySelectorAll('.iqrate button').forEach((x) => { x.disabled = true; });
      const r = await window.Terms.rpc('ma_iq_save', { p_pass: pass, p_qid: q.id, p_answer: round.draft.trim(), p_rating: rating });
      if (!r.ok) {
        if (r.error === 'forbidden') { forget(); flash = ERR.forbidden; Q = []; loaded = false; return renderGate(); }
        el.querySelectorAll('.iqrate button').forEach((x) => { x.disabled = false; });
        $('#isaveMsg').textContent = ERR[r.error] || ERR.network;
        return;
      }
      const old = prog.get(q.id);
      prog.set(q.id, { qid: q.id, answer: round.draft.trim(), rating, attempts: (old?.attempts || 0) + 1 });
      round.results[q.id] = rating;
      round.rated = rating;
      renderActions(q, last);
    };
    const next = $('#inext');
    if (next) next.onclick = () => advance(last);
  }

  function advance(last) {
    round.i++;
    round.draft = ''; round.revealed = false; round.rated = null;
    last ? renderResult() : renderQuestion();
  }

  // ---------- resultat ----------
  function renderResult() {
    view = renderResult;
    const vals = Object.values(round.results);
    const c = (k) => vals.filter((v) => v === k).length;
    const skipped = round.qs.length - vals.length;
    const hard = round.qs.filter((q) => ['missed', 'partial'].includes(round.results[q.id]));
    root().innerHTML = `
      <div class="card">
        <h2 class="qh">Klart!</h2>
        <div class="qstats">
          <div><b>${c('nailed')}</b><span>klarade</span></div>
          <div><b>${c('partial')}</b><span>delvis</span></div>
          <div><b>${c('missed')}</b><span>missade</span></div>
        </div>
        ${skipped ? `<p class="qsub">${skipped} hoppades över.</p>` : ''}
        ${hard.length ? `<div class="qlabel">Öva mer på dessa</div>${hard.map((q) => `<div class="qmiss"><b>${esc(RATE[round.results[q.id]])}</b>${esc(q.q)}</div>`).join('')}` : ''}
        <button class="qbtn primary" id="iagain">Spela igen</button>
        <button class="qbtn ghost" id="ihome">Till startsidan</button>
      </div>`;
    $('#iagain').onclick = start;
    $('#ihome').onclick = () => { round = null; renderHome(); };
  }

  // Anropas av flikhanteraren (tabs.js) när Intervju-fliken öppnas
  window.onInterviewShow = async () => {
    if (loaded) return view();
    if (loading) return;
    if (pass) return load(pass, false);
    renderGate();
  };
})();
