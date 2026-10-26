// Quizpåminnelser: välj hur många gånger per dag och vilka klockslag. Servern (pg_cron) skickar en pushnotis på varje tid.
(() => {
  const C = window.CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAX = 6, MIN_GAP = 30; // högst 6 per dag, minst 30 minuter mellan två tider

  // Förslag på tider beroende på antal
  const DEFAULTS = {
    1: ['18:00'],
    2: ['08:00', '18:00'],
    3: ['08:00', '13:00', '19:00'],
    4: ['08:00', '12:00', '16:00', '20:00'],
    5: ['08:00', '11:00', '14:00', '17:00', '20:00'],
    6: ['08:00', '10:30', '13:00', '15:30', '18:00', '20:30'],
  };
  const ERR = {
    invalid_times: 'Ogiltiga tider. Kontrollera klockslagen.',
    invalid_tz: 'Tidszonen kändes inte igen.',
    invalid: 'Något gick fel när påminnelsen skulle sparas.',
    network: 'Kunde inte nå servern. Försök igen.',
    not_found: 'Spara påminnelsen först.',
    wait: 'Vänta en halv minut mellan testnotiserna.',
  };

  const urlB64 = (b) => {
    const p = '='.repeat((4 - (b.length % 4)) % 4);
    const r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...r].map((c) => c.charCodeAt(0)));
  };
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm'; } catch { return 'Europe/Stockholm'; } };
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const isIos = /iPhone|iPad/.test(navigator.userAgent);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const state = { loaded: false, busy: false, endpoint: null, server: { exists: false }, times: DEFAULTS[2].slice(), msg: '' };
  let host = null;

  const rpc = (fn, args) => window.Terms.rpc(fn, args);

  async function getReg() {
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register('sw.js');
    return reg;
  }

  async function loadServerState() {
    state.loaded = true;
    if (!supported) return;
    try {
      const reg = await getReg();
      const sub = await reg.pushManager.getSubscription();
      state.endpoint = sub ? sub.endpoint : null;
      if (sub) {
        const s = await rpc('ma_reminder_get', { p_endpoint: sub.endpoint });
        if (s && s.exists) {
          state.server = s;
          if (s.enabled && Array.isArray(s.times) && s.times.length) state.times = s.times.slice();
        }
      }
    } catch (e) { console.warn('Kunde inte läsa påminnelsen:', e.message); }
  }

  function render() {
    if (!host) return;
    const on = state.server.exists && state.server.enabled;
    const n = state.times.length;
    const blocked = !supported || (isIos && !standalone);
    host.innerHTML = `
      <h3 class="qh" style="font-size:18px">⏰ Påminnelse</h3>
      <p class="qsub">Få en notis när det är dags att öva förkortningarna.</p>
      ${on ? `<div class="gflash" style="margin-top:0">På: ${esc(state.server.times.join(', '))}</div>` : ''}
      ${blocked ? `<div class="banner">${!supported ? 'Notiser stöds inte i den här webbläsaren.' : 'På iPhone krävs att appen ligger på hemskärmen: tryck <b>Dela</b> i Safari, välj <b>Lägg till på hemskärmen</b> och öppna appen därifrån.'}</div>` : ''}
      <div class="qlabel">Antal gånger per dag</div>
      <div class="qchips" id="rcount">
        ${Array.from({ length: MAX }, (_, i) => i + 1).map((k) => `<button class="chip ${k === n ? 'active' : ''}" data-n="${k}">${k}</button>`).join('')}
      </div>
      <div class="qlabel">Klockslag</div>
      <div class="rtimes">
        ${state.times.map((t, i) => `<label class="rtime"><span>${i + 1}</span><input type="time" class="qinput" data-i="${i}" value="${esc(t)}" step="300" aria-label="Tid ${i + 1}"></label>`).join('')}
      </div>
      <button class="qbtn primary" id="rsave" ${blocked || state.busy ? 'disabled' : ''}>${on ? 'Uppdatera påminnelse' : 'Slå på påminnelse'}</button>
      ${on ? `<button class="qbtn ghost" id="rtest" ${state.busy ? 'disabled' : ''}>Skicka en testnotis nu</button>
              <button class="qbtn ghost" id="roff" ${state.busy ? 'disabled' : ''}>Stäng av påminnelse</button>` : ''}
      <div class="iqnote" id="rmsg" role="status">${esc(state.msg)}</div>`;
    wire();
  }

  function wire() {
    $('#rcount', host).onclick = (e) => {
      const b = e.target.closest('[data-n]');
      if (!b) return;
      const k = Number(b.dataset.n);
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (same([...state.times].sort(), DEFAULTS[state.times.length] || [])) {
        // användaren har inte ändrat tiderna: byt till förslaget för det nya antalet
        state.times = DEFAULTS[k].slice();
      } else {
        // behåll de tider som redan är valda och fyll på med förslag som inte krockar (inom 30 min)
        const next = state.times.slice(0, k);
        for (const cand of DEFAULTS[k]) {
          if (next.length >= k) break;
          if (next.every((t) => Math.abs(mins(t) - mins(cand)) >= MIN_GAP)) next.push(cand);
        }
        for (let m = 7 * 60; next.length < k && m < 23 * 60; m += 60) { // reserv: första lediga hela timme
          const cand = `${String(Math.floor(m / 60)).padStart(2, '0')}:00`;
          if (next.every((t) => Math.abs(mins(t) - mins(cand)) >= MIN_GAP)) next.push(cand);
        }
        state.times = next.sort();
      }
      state.msg = '';
      render();
    };
    host.querySelectorAll('.rtime input').forEach((inp) => {
      inp.onchange = () => { state.times[Number(inp.dataset.i)] = inp.value; state.msg = ''; };
    });
    const save = $('#rsave', host), test = $('#rtest', host), off = $('#roff', host);
    if (save) save.onclick = doSave;
    if (test) test.onclick = doTest;
    if (off) off.onclick = doOff;
  }

  const setMsg = (m) => { state.msg = m; const el = $('#rmsg', host); if (el) el.textContent = m; };
  const busy = (b) => { state.busy = b; host.querySelectorAll('button').forEach((x) => { x.disabled = b; }); };

  function validate() {
    const t = state.times.map((x) => (x || '').trim());
    if (t.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))) return 'Fyll i alla klockslag.';
    const sorted = [...t].sort();
    for (let i = 1; i < sorted.length; i++) {
      if (mins(sorted[i]) - mins(sorted[i - 1]) < MIN_GAP) return `Tiderna måste ligga minst ${MIN_GAP} minuter isär.`;
    }
    return null;
  }

  async function doSave() {
    const bad = validate();
    if (bad) return setMsg(bad);
    busy(true);
    try {
      // Tillståndsfrågan måste ställas direkt från knapptryckningen.
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') { busy(false); return setMsg('Notiser är blockerade. Tillåt dem för appen i iPhonens inställningar.'); }
      const reg = await getReg();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // ny prenumeration enbart för påminnelsen: håll affärsnotiserna (🔔) avstängda
        try { if (localStorage.getItem('ma.deals') == null) localStorage.setItem('ma.deals', '0'); } catch {}
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(C.VAPID_PUBLIC_KEY) });
      }
      const j = sub.toJSON();
      const r = await rpc('ma_reminder_save', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_times: state.times, p_tz: tz() });
      if (!r.ok) { busy(false); return setMsg(ERR[r.error] || ERR.network); }
      state.endpoint = j.endpoint;
      state.server = { exists: true, enabled: true, times: r.times, tz: r.tz };
      state.times = r.times.slice();
      state.msg = 'Sparat. Du får en notis vid de tider du valt.';
    } catch (e) {
      busy(false);
      return setMsg('Det gick inte att slå på notiser: ' + e.message);
    }
    state.busy = false;
    render();
  }

  async function doTest() {
    busy(true);
    const r = await rpc('ma_reminder_test', { p_endpoint: state.endpoint });
    state.busy = false;
    state.msg = r.ok ? 'Testnotisen är skickad. Den dyker upp om några sekunder.' : (ERR[r.error] || ERR.network);
    render();
  }

  async function doOff() {
    busy(true);
    const r = await rpc('ma_reminder_delete', { p_endpoint: state.endpoint });
    state.busy = false;
    if (r.ok) { state.server = { exists: false }; state.msg = 'Påminnelsen är avstängd.'; } else state.msg = ERR[r.error] || ERR.network;
    render();
  }

  // Anropas av quiz.js varje gång startsidan ritas
  window.Reminder = {
    mount(el) {
      host = el;
      render();
      if (!state.loaded) loadServerState().then(() => { if (host && host.isConnected) render(); });
    },
  };
})();
