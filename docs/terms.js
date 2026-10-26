// Delad datakälla för förkortningar. Ordlistan och quizet läser båda härifrån, så en ändring syns i båda.
// Ordning: sparad kopia på enheten -> filen quiz-data.js (reserv) -> databasen (Supabase), som alltid vinner när den svarar.
(() => {
  const C = window.CONFIG;
  const H = { apikey: C.SUPABASE_KEY, Authorization: 'Bearer ' + C.SUPABASE_KEY, 'Content-Type': 'application/json' };
  const CACHE = 'terms.cache.v1';
  const subs = [];

  let list = window.QUIZ_DATA.map(([a, f, s, c]) => ({ a, f, s, c }));
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE) || 'null');
    if (Array.isArray(cached) && cached.length) list = cached;
  } catch {}

  const notify = () => subs.forEach((fn) => { try { fn(list); } catch (e) { console.warn(e); } });

  async function refresh() {
    try {
      const r = await fetch(`${C.SUPABASE_URL}/rest/v1/ma_terms?select=abbr,full_name,sv,cat&order=abbr.asc&limit=2000`, { headers: H });
      if (!r.ok) return;
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) return;
      const next = rows.map((x) => ({ a: x.abbr, f: x.full_name, s: x.sv, c: x.cat }));
      if (JSON.stringify(next) === JSON.stringify(list)) return;
      list = next;
      try { localStorage.setItem(CACHE, JSON.stringify(list)); } catch {}
      notify();
    } catch {}
  }

  // Redigeringsfunktionerna kontrollerar lösenordet i databasen och svarar { ok, error? }.
  async function rpc(fn, args) {
    try {
      const r = await fetch(`${C.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
      if (!r.ok) return { ok: false, error: 'network' };
      return await r.json();
    } catch { return { ok: false, error: 'network' }; }
  }

  window.Terms = {
    get list() { return list; },
    subscribe: (fn) => subs.push(fn),
    refresh,
    login: (pass) => rpc('ma_admin_login', { p_pass: pass }),
    save: (pass, t) => rpc('ma_term_save', { p_pass: pass, p_abbr: t.a, p_full: t.f, p_sv: t.s, p_cat: t.c }).then(async (r) => { if (r.ok) await refresh(); return r; }),
    remove: (pass, abbr) => rpc('ma_term_delete', { p_pass: pass, p_abbr: abbr }).then(async (r) => { if (r.ok) await refresh(); return r; }),
  };

  refresh();
  setInterval(refresh, 5 * 60 * 1000);
})();
