// Jobbflödet: hämtar finansjobb från Arbetsförmedlingens öppna jobbdata (JobTech/Platsbanken), klassar område och nivå,
// sparar i ma_jobs och skickar pushnotiser till den som valt det. Körs var 30:e minut av pg_cron (ma_jobs_tick).
// Driftsatt i Supabase som funktionen "ma-jobs" (verify_jwt av, hemligheten kontrolleras nedan).
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API = "https://jobsearch.api.jobtechdev.se/search";

type Cat = "analys" | "cf" | "forvaltning" | "bank" | "ekonomi";
type Level = "praktik" | "trainee" | "junior" | "erfaren";
type Job = {
  id: string; headline: string; employer: string | null; municipality: string | null; region: string | null;
  published: string; deadline: string | null; url: string; apply_url: string | null;
  category: Cat; level: Level; occupation: string | null; snippet: string;
};

// Arbetsförmedlingens yrkesgrupper (taxonomin är stabil)
const GROUPS: { id: string; cat: Cat }[] = [
  { id: "pTr9_RBT_9ur", cat: "analys" },      // Finansanalytiker och investeringsrådgivare m.fl.
  { id: "Bbkh_nrm_2J8", cat: "forvaltning" }, // Traders och fondförvaltare
  { id: "FfMN_Bw1_qYR", cat: "bank" },        // Banktjänstemän
  { id: "Uw4n_UB2_RCW", cat: "ekonomi" },     // Controller
  { id: "q81z_3oD_1qu", cat: "ekonomi" },     // Redovisningsekonomer
  { id: "cRmd_536_pT1", cat: "ekonomi" },     // Revisorer m.fl.
];
// Fritext för corporate finance/M&A, som sällan ligger i en egen yrkesgrupp. Träffar måste också matcha CF_RE (annars blir det brus).
const CF_QUERIES = ["corporate finance", "M&A", "mergers acquisitions", "private equity", "investment banking", "transaktionsrådgivning", "due diligence", "financial advisory"];
// Rubriken måste tala om corporate finance/M&A, eller beskrivningens första rader måste göra det tydligt (annars fångas t.ex. "CDD Analyst" för penningtvätt).
const CF_HEAD = /corporate finance|\bm&a\b|mergers|acquisitions|private equity|investment (bank|associate|analyst|manager|director|professional)|financial advisory|transaktionsrådgiv|transaction (advisory|services|support)|corporate development|\blbo\b|venture capital|equity research|fusioner och förvärv|förvärv och avyttring/i;
const CF_BODY = /corporate finance|\bm&a\b|mergers (and|&) acquisitions|private equity|investment bank|transaktionsrådgiv/i;
const NOISE = /tjäna\s+\d|mötesbokare|telefonförsäljare|säljare|kundtjänst|merchandiser|butik|kundmottagare|nätverksmarknad|provisionsbaserad|vaktmästare|städ|kundbemöt|service och kund|servicepersonal|professor|lektor|doktorand|solution architect|systems business analyst/i;
const PUSH_MAX_AGE_MS = 48 * 3600e3;

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });

// API:et ger svensk lokal tid utan tidszon. Gör om till UTC.
function stockholmToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const asUtc = Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s.replace(/Z?$/, "Z"));
  if (isNaN(asUtc)) return null;
  const d = new Date(asUtc);
  const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Stockholm" })).getTime();
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(asUtc - (local - utc)).toISOString();
}

function levelOf(headline: string, desc: string): Level {
  const h = headline.toLowerCase();
  if (/praktik|internship|\bintern\b|sommarjobb|summer analyst|extrajobb|examensarbete|studentmedarbetare|student f/.test(h)) return "praktik";
  if (/trainee|graduate|nyexaminerad|nyutexaminerad|early career|talent program|management program/.test(h)) return "trainee";
  if (/junior|juniora|entry[- ]level|nyanställd/.test(h)) return "junior";
  const d = desc.slice(0, 700).toLowerCase();
  if (/trainee|graduate program|traineeprogram|nyexaminerad|nyutexaminerad/.test(d)) return "trainee";
  if (/junior|ingen tidigare erfarenhet|entry[- ]level/.test(d)) return "junior";
  return "erfaren";
}

async function search(params: string): Promise<Record<string, any>[]> {
  try {
    const res = await fetch(`${API}?${params}&sort=pubdate-desc`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    return ((await res.json()).hits || []) as Record<string, any>[];
  } catch (e) {
    console.warn("jobsearch-fel", params.slice(0, 60), (e as Error).message);
    return [];
  }
}

function toJob(h: Record<string, any>, cat: Cat): Job | null {
  if (!h || h.removed || !h.id || !h.headline || !h.webpage_url) return null;
  const desc: string = h.description?.text || "";
  if (NOISE.test(h.headline) || NOISE.test(desc.slice(0, 300))) return null;
  const deadline = stockholmToIso(h.application_deadline);
  if (deadline && Date.parse(deadline) < Date.now()) return null; // sista ansökningsdag har passerat
  const applyUrl = h.application_details?.url;
  return {
    id: String(h.id), headline: String(h.headline).slice(0, 200),
    employer: h.employer?.name || h.employer?.workplace || null,
    municipality: h.workplace_address?.municipality || h.workplace_address?.city || null,
    region: h.workplace_address?.region || null,
    published: stockholmToIso(h.publication_date) || new Date().toISOString(), deadline,
    url: h.webpage_url, apply_url: typeof applyUrl === "string" && /^https?:\/\//.test(applyUrl) ? applyUrl : null,
    category: cat, level: levelOf(h.headline, desc), occupation: h.occupation?.label || null,
    snippet: desc.replace(/\s+/g, " ").trim().slice(0, 420),
  };
}

async function sendPush(cfg: { vapid_public: string; vapid_private: string }, jobs: Job[]) {
  const subs: { endpoint: string; p256dh: string; auth: string; levels: string[]; categories: string[]; region: string | null }[] =
    await (await rest("ma_jobs_subs?enabled=eq.true&select=endpoint,p256dh,auth,levels,categories,region")).json();
  if (!subs.length) return { sent: 0, dead: 0 };
  webpush.setVapidDetails("mailto:lucas06.tekin@gmail.com", cfg.vapid_public, cfg.vapid_private);
  const recent = jobs.filter((j) => Date.now() - +new Date(j.published) < PUSH_MAX_AGE_MS);
  const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" }) : "";
  const dead: string[] = [];
  let sent = 0;
  for (const s of subs) {
    const cand = recent.filter((j) => s.levels.includes(j.level) && s.categories.includes(j.category) && (!s.region || j.region === s.region));
    if (!cand.length) continue;
    const msgs = cand.length <= 3
      ? cand.map((j) => ({ title: `💼 ${j.employer || "Nytt jobb"}`, body: `${j.headline}${j.municipality ? " · " + j.municipality : ""}${j.deadline ? " · sista dag " + fmt(j.deadline) : ""}` }))
      : [{ title: `💼 ${cand.length} nya jobb`, body: cand.slice(0, 3).map((j) => j.headline).join(" · ") }];
    for (const m of msgs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...m, url: "./#jobb" }));
        sent++;
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) { dead.push(s.endpoint); break; }
        console.error("push-fel", st, String((e as Error).message).slice(0, 120));
      }
    }
  }
  if (dead.length) await rest(`ma_jobs_subs?endpoint=in.(${encodeURIComponent(dead.map((d) => `"${d.replaceAll('"', "")}"`).join(","))})`, { method: "DELETE" });
  return { sent, dead: dead.length };
}

Deno.serve(async (req) => {
  try {
    const cfg = (await (await rest("ma_config?id=eq.1&select=reminder_secret,vapid_public,vapid_private")).json())[0];
    const given = req.headers.get("x-reminder-secret");
    if (!cfg?.reminder_secret || !given || given !== cfg.reminder_secret) return new Response("forbidden", { status: 403 });
    const dry = !!((await req.json().catch(() => ({}))) as { dry?: boolean }).dry;

    const firstRun = ((await (await rest("ma_jobs?select=id&limit=1")).json()) as unknown[]).length === 0;

    // 1) corporate finance/M&A via fritext (strängare filter), 2) yrkesgrupper
    const found = new Map<string, Job>();
    const cfHits = await Promise.all(CF_QUERIES.map((q) => search(`q=${encodeURIComponent(q)}&limit=50`)));
    for (const h of cfHits.flat()) {
      if (!CF_HEAD.test(h.headline || "") && !CF_BODY.test((h.description?.text || "").slice(0, 400))) continue;
      const j = toJob(h, "cf");
      if (j) found.set(j.id, j);
    }
    const groupHits = await Promise.all(GROUPS.map(async (g) => ({ cat: g.cat, hits: await search(`occupation-group=${g.id}&limit=100`) })));
    for (const { cat, hits } of groupHits) {
      for (const h of hits) {
        const j = toJob(h, cat);
        if (j && !found.has(j.id)) found.set(j.id, j);
      }
    }

    const known = new Set(((await (await rest("ma_jobs?select=id&limit=10000")).json()) as { id: string }[]).map((r) => r.id));
    const fresh = [...found.values()].filter((j) => !known.has(j.id));

    if (dry) {
      const by: Record<string, number> = {};
      for (const j of found.values()) by[`${j.category}/${j.level}`] = (by[`${j.category}/${j.level}`] || 0) + 1;
      return Response.json({ ok: true, dry: true, found: found.size, fresh: fresh.length, perKategoriNivå: by,
        studentvänliga: [...found.values()].filter((j) => j.level !== "erfaren").map((j) => `${j.category}/${j.level} | ${j.employer} | ${j.headline.slice(0, 55)}`).slice(0, 40) });
    }
    if (!fresh.length) return Response.json({ ok: true, found: found.size, fresh: 0 });

    const ins = await rest("ma_jobs?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(fresh) });
    if (!ins.ok) { console.error("insert", ins.status, (await ins.text()).slice(0, 300)); return Response.json({ ok: false, error: "insert_failed" }, { status: 500 }); }
    const insertedIds = new Set(((await ins.json()) as { id: string }[]).map((r) => r.id));
    const inserted = fresh.filter((j) => insertedIds.has(j.id));

    let push = { sent: 0, dead: 0 };
    if (!firstRun && cfg.vapid_public && cfg.vapid_private) push = await sendPush(cfg, inserted);
    return Response.json({ ok: true, found: found.size, inserted: inserted.length, push, firstRun });
  } catch (e) {
    console.error("ma-jobs", (e as Error).message);
    return Response.json({ ok: false, error: "server" }, { status: 500 });
  }
});
