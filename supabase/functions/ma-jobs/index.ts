// Jobbflödet: hämtar finansjobb från (1) Arbetsförmedlingens öppna jobbdata (Platsbanken) och (2) finansbolagens egna karriärsidor
// (PwC, Deloitte, Handelsbanken, Nordea, EQT m.fl.), klassar område och nivå, sparar i ma_jobs och skickar pushnotiser.
// Körs var 30:e minut av pg_cron (ma_jobs_tick). Driftsatt i Supabase som funktionen "ma-jobs" (verify_jwt av, hemligheten kontrolleras nedan).
import webpush from "npm:web-push@3.6.7";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API = "https://jobsearch.api.jobtechdev.se/search";
const UA = "Mozilla/5.0 (compatible; DinFinansApp/1.0)";

type Cat = "analys" | "cf" | "forvaltning" | "bank" | "ekonomi";
type Level = "praktik" | "trainee" | "junior" | "erfaren";
type Job = {
  id: string; headline: string; employer: string | null; municipality: string | null; region: string | null;
  published: string; deadline: string | null; url: string; apply_url: string | null;
  category: Cat; level: Level; occupation: string | null; snippet: string;
};
// Rådata från ett bolags karriärsida, innan klassning
type Raw = {
  id: string; title: string; city: string | null; region: string | null; published: string | null; deadline: string | null;
  url: string; apply_url?: string | null; dept?: string; type?: string; exp?: string; desc?: string;
};
type Company = { key: string; name: string; bank?: boolean; fetch: () => Promise<Raw[]> };

// ---------- Platsbanken (Arbetsförmedlingen) ----------
const GROUPS: { id: string; cat: Cat }[] = [
  { id: "pTr9_RBT_9ur", cat: "analys" },      // Finansanalytiker och investeringsrådgivare m.fl.
  { id: "Bbkh_nrm_2J8", cat: "forvaltning" }, // Traders och fondförvaltare
  { id: "FfMN_Bw1_qYR", cat: "bank" },        // Banktjänstemän
  { id: "Uw4n_UB2_RCW", cat: "ekonomi" },     // Controller
  { id: "q81z_3oD_1qu", cat: "ekonomi" },     // Redovisningsekonomer
  { id: "cRmd_536_pT1", cat: "ekonomi" },     // Revisorer m.fl.
];
const CF_QUERIES = ["corporate finance", "M&A", "mergers acquisitions", "private equity", "investment banking", "transaktionsrådgivning", "due diligence", "financial advisory"];
// Rubriken måste tala om corporate finance/M&A, eller beskrivningens första rader måste göra det tydligt (annars fångas t.ex. "CDD Analyst" för penningtvätt).
const CF_HEAD = /corporate finance|\bm&a\b|mergers|acquisitions|private equity|investment (bank|associate|analyst|manager|director|professional)|financial advisory|transaktionsrådgiv|transaction (advisory|services|support)|corporate development|\blbo\b|venture capital|equity research|fusioner och förvärv|förvärv och avyttring/i;
const CF_BODY = /corporate finance|\bm&a\b|mergers (and|&) acquisitions|private equity|investment bank|transaktionsrådgiv/i;
const NOISE = /tjäna\s+\d|mötesbokare|telefonförsäljare|säljare|kundtjänst|merchandiser|butik|kundmottagare|nätverksmarknad|provisionsbaserad|vaktmästare|städ|kundbemöt|service och kund|servicepersonal|professor|lektor|doktorand|solution architect|systems business analyst/i;

// ---------- Bolagens egna karriärsidor ----------
const get = async (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
const J = async (url: string, init: RequestInit = {}) => { const r = await get(url, init); if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`); return r.json(); };
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true });
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const strip = (s: unknown) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// Jobylon (används av bl.a. PwC och Handelsbanken): öppet JSON-flöde med anställningstyp och erfarenhetsnivå
const jobylon = (token: string) => async (): Promise<Raw[]> =>
  arr<any>(await J(`https://feed.jobylon.com/feeds/${token}/?format=json`)).map((x) => {
    const loc = x.locations?.[0]?.location;
    return {
      id: String(x.id), title: strip(x.title), city: loc?.city || null, region: loc?.area_1 || null, published: x.from_date || x.dt_created || null,
      deadline: x.to_date || null, url: x.urls?.ad, apply_url: x.urls?.apply || null, dept: [x.function, ...(x.departments || []).map((d: any) => d.department?.name)].filter(Boolean).join(" "),
      type: x.employment_type || "", exp: x.experience || "", desc: strip(x.descr || x.summary),
    };
  });

// Teamtailor (ABG, Nordic Capital, SBAB, Skandia): öppet RSS-flöde
const teamtailor = (slug: string) => async (): Promise<Raw[]> => {
  const r = await get(`https://${slug}.teamtailor.com/jobs.rss`);
  if (!r.ok) throw new Error(`${r.status} teamtailor ${slug}`);
  const doc = xml.parse(await r.text());
  return arr<any>(doc?.rss?.channel?.item).map((x) => ({
    id: String(x.guid?.["#text"] ?? x.guid ?? x.link), title: strip(x.title), city: null, region: null, published: x.pubDate || null, deadline: null,
    url: String(x.link), desc: strip(x.description),
  }));
};

const COMPANIES: Company[] = [
  { key: "pwc", name: "PwC", fetch: jobylon("f2bec1d5-600b-4990-80f7-6e0c3ffcfa4b") },
  { key: "shb", name: "Handelsbanken", bank: true, fetch: jobylon("9e8d6849-bf9f-4eda-a952-8d0a366cee74") },
  {
    key: "deloitte", name: "Deloitte", // SmartRecruiters (hela Norden, filtreras på Sverige)
    fetch: async () => {
      const out: Raw[] = [];
      for (let off = 0; off < 300; off += 100) {
        const d = await J(`https://api.smartrecruiters.com/v1/companies/DeloitteNordic/postings?limit=100&offset=${off}&country=se`);
        for (const x of arr<any>(d.content)) {
          out.push({
            id: String(x.id), title: strip(x.name), city: x.location?.city || null, region: null, published: x.releasedDate || null, deadline: null,
            url: `https://jobs.smartrecruiters.com/DeloitteNordic/${x.id}`, dept: [x.function?.label, x.department?.label, x.industry?.label].filter(Boolean).join(" "),
            type: x.typeOfEmployment?.label || "", exp: x.experienceLevel?.label || "",
          });
        }
        if (arr(d.content).length < 100) break;
      }
      return out;
    },
  },
  {
    key: "nordea", name: "Nordea", bank: true, // Nordeas eget öppna jobb-API (alla Norden, filtreras på Sverige)
    fetch: async () => {
      const out: Raw[] = [];
      for (let p = 0; p < 4; p++) {
        const d = await J(`https://www.nordea.com/en/api/jobs-list?_format=json&items_per_page=100&page=${p}&search=`);
        for (const x of arr<any>(d.results)) {
          if (!/sweden/i.test(x.location_name || "")) continue;
          out.push({
            id: String(x.nid), title: strip(x.title), city: String(x.location_name).replace(/^Sweden,\s*/i, "").split(",")[0].trim() || null, region: null,
            published: x.created || null, deadline: x.field_apply_due || null, url: String(x.field_ad_url || x.url).replace(/&amp;/g, "&").replace(/[?&]feedId=.*$/, ""),
            dept: x.category_name || "",
          });
        }
        if (arr(d.results).length < 100) break;
      }
      return out;
    },
  },
  {
    key: "eqt", name: "EQT", // Greenhouse
    fetch: async () => arr<any>((await J("https://boards-api.greenhouse.io/v1/boards/eqtpartners/jobs?content=true")).jobs)
      .filter((x) => /sweden|stockholm|sverige/i.test(x.location?.name || ""))
      .map((x) => ({
        id: String(x.id), title: strip(x.title), city: String(x.location?.name).split(",")[0].trim(), region: null, published: x.first_published || x.updated_at || null, deadline: null,
        url: x.absolute_url, dept: arr<any>(x.departments).map((d) => d.name).join(" "), desc: strip(x.content),
      })),
  },
  { key: "abg", name: "ABG Sundal Collier", fetch: teamtailor("abgsc") },
  { key: "nc", name: "Nordic Capital", fetch: teamtailor("nordiccapital") },
  { key: "sbab", name: "SBAB", bank: true, fetch: teamtailor("sbab") },
  { key: "skandia", name: "Skandia", bank: true, fetch: teamtailor("skandia") },
];

// Vilka bolagsjobb är relevanta för en finansstudent (resten, t.ex. IT och HR, hoppas över)
const FIN_RE = /financ|finans|analy|audit|revis|advis|rådgiv|invest|portfolio|portfölj|förvalt|asset|risk|control|redovis|account|\btax\b|skatt|transaction|\bdeal|m&a|corporate|credit|kredit|equity|capital|kapital|treasury|bank|trading|trader|ekonom|economist|valuation|värdering|restructuring|trainee|graduate|intern|praktik|junior|student|associate|compliance|\baml\b|actuar|aktuar|\bfund|fond|wealth|private|research|forensic|insolv|konkurs|likvid|derivat|markets|sales/i;
const NOT_FIN_RE = /developer|utvecklare|software|devops|full ?stack|front ?end|back ?end|architect|arkitekt|scrum|product owner|\btest(are|er)\b|\bux\b|ui designer|sysadmin|cloud engineer|kubernetes|java\b|python|salesforce|\bsap\b|cyber|network engineer|helpdesk|support engineer|data engineer|machine learning/i;
const CITY_REGION: Record<string, string> = {
  stockholm: "Stockholms län", solna: "Stockholms län", kista: "Stockholms län", sundbyberg: "Stockholms län", nacka: "Stockholms län", täby: "Stockholms län", lidingö: "Stockholms län", huddinge: "Stockholms län", södertälje: "Stockholms län",
  göteborg: "Västra Götalands län", gothenburg: "Västra Götalands län", mölndal: "Västra Götalands län", borås: "Västra Götalands län", skövde: "Västra Götalands län", trollhättan: "Västra Götalands län",
  malmö: "Skåne län", lund: "Skåne län", helsingborg: "Skåne län", kristianstad: "Skåne län", uppsala: "Uppsala län", enköping: "Uppsala län", linköping: "Östergötlands län", norrköping: "Östergötlands län",
  jönköping: "Jönköpings län", örebro: "Örebro län", västerås: "Västmanlands län", umeå: "Västerbottens län", luleå: "Norrbottens län", karlstad: "Värmlands län", växjö: "Kronobergs län", gävle: "Gävleborgs län",
  sundsvall: "Västernorrlands län", halmstad: "Hallands län", kalmar: "Kalmar län", falun: "Dalarnas län", borlänge: "Dalarnas län", visby: "Gotlands län",
};

function categorize(text: string, bank: boolean): Cat {
  if (/m&a|mergers|corporate finance|transaction (services|advisory|support)|\bdeal|investment banking|capital markets|debt advisory|leveraged|restructuring|valuation|värdering|private equity|due diligence|corporate development/i.test(text)) return "cf";
  if (/portfolio|portfölj|asset manag|förvalt|\bfund|fond|wealth|investment (manager|analyst|associate|professional)|trading|trader|quant|markets/i.test(text)) return "forvaltning";
  if (/audit|revis|\btax\b|skatt|account|redovis|control|financial reporting|treasury|actuar|aktuar|forensic|bokslut|ekonom/i.test(text)) return "ekonomi";
  if (bank) return "bank";
  return "analys";
}

function levelOf(headline: string, desc: string, type = "", exp = ""): Level {
  const h = (headline + " " + type).toLowerCase();
  if (/praktik|internship|\bintern\b|interns\b|sommarjobb|summer analyst|extrajobb|examensarbete|studentmedarbetare|student f/.test(h)) return "praktik";
  if (/trainee|graduate|nyexaminerad|nyutexaminerad|early career|talent program|management program/.test(h)) return "trainee";
  if (/junior|juniora|entry[- ]level|nyanställd/.test(h + " " + exp.toLowerCase())) return "junior";
  const d = desc.slice(0, 700).toLowerCase();
  if (/trainee|graduate program|traineeprogram|nyexaminerad|nyutexaminerad/.test(d)) return "trainee";
  if (/junior|ingen tidigare erfarenhet|entry[- ]level/.test(d)) return "junior";
  return "erfaren";
}

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });

// Platsbanken ger svensk lokal tid utan tidszon. Gör om till UTC.
function stockholmToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const asUtc = Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s.replace(/Z?$/, "Z"));
  if (isNaN(asUtc)) return null;
  const d = new Date(asUtc);
  const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Stockholm" })).getTime();
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(asUtc - (local - utc)).toISOString();
}
const anyIso = (s: string | null | undefined): string | null => { if (!s) return null; const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString(); };

async function search(params: string): Promise<Record<string, any>[]> {
  try {
    const res = await get(`${API}?${params}&sort=pubdate-desc`);
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

function companyJob(c: Company, r: Raw): Job | null {
  if (!r.title || !r.url || !/^https?:\/\//.test(r.url)) return null;
  const text = `${r.title} ${r.dept || ""}`;
  if (NOISE.test(r.title) || NOT_FIN_RE.test(r.title) || !FIN_RE.test(text)) return null;
  const deadline = anyIso(r.deadline && r.deadline.length <= 10 ? r.deadline + "T23:59:59Z" : r.deadline);
  if (deadline && Date.parse(deadline) < Date.now()) return null;
  const city = r.city && !/^(sweden|sverige|remote)$/i.test(r.city) ? r.city : null;
  return {
    id: `${c.key}:${r.id}`, headline: r.title.slice(0, 200), employer: c.name, municipality: city,
    region: r.region || (city ? CITY_REGION[city.toLowerCase()] || null : null),
    published: anyIso(r.published) || new Date().toISOString(), deadline, url: r.url, apply_url: r.apply_url || null,
    category: categorize(text, !!c.bank), level: levelOf(r.title, r.desc || "", r.type, r.exp), occupation: (r.dept || "").slice(0, 80) || null,
    snippet: (r.desc || "").slice(0, 420),
  };
}

async function sendPush(cfg: { vapid_public: string; vapid_private: string }, jobs: Job[]) {
  const subs: { endpoint: string; p256dh: string; auth: string; levels: string[]; categories: string[]; region: string | null }[] =
    await (await rest("ma_jobs_subs?enabled=eq.true&select=endpoint,p256dh,auth,levels,categories,region")).json();
  if (!subs.length) return { sent: 0, dead: 0 };
  webpush.setVapidDetails("mailto:lucas06.tekin@gmail.com", cfg.vapid_public, cfg.vapid_private);
  const recent = jobs.filter((j) => Date.now() - +new Date(j.published) < 48 * 3600e3);
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-zåäö0-9]+/g, " ").trim();

Deno.serve(async (req) => {
  try {
    const cfg = (await (await rest("ma_config?id=eq.1&select=reminder_secret,vapid_public,vapid_private")).json())[0];
    const given = req.headers.get("x-reminder-secret");
    if (!cfg?.reminder_secret || !given || given !== cfg.reminder_secret) return new Response("forbidden", { status: 403 });
    const dry = !!((await req.json().catch(() => ({}))) as { dry?: boolean }).dry;

    const firstRun = ((await (await rest("ma_jobs?select=id&limit=1")).json()) as unknown[]).length === 0;
    const found = new Map<string, Job>();

    // 1) Platsbanken: corporate finance/M&A via fritext, därefter yrkesgrupper
    const cfHits = await Promise.all(CF_QUERIES.map((q) => search(`q=${encodeURIComponent(q)}&limit=50`)));
    for (const h of cfHits.flat()) {
      if (!CF_HEAD.test(h.headline || "") && !CF_BODY.test((h.description?.text || "").slice(0, 400))) continue;
      const j = toJob(h, "cf");
      if (j) found.set(j.id, j);
    }
    const groupHits = await Promise.all(GROUPS.map(async (g) => ({ cat: g.cat, hits: await search(`occupation-group=${g.id}&limit=100`) })));
    for (const { cat, hits } of groupHits) for (const h of hits) { const j = toJob(h, cat); if (j && !found.has(j.id)) found.set(j.id, j); }
    const fromPlatsbanken = found.size;

    // 2) Bolagens egna karriärsidor. Ett fel hos ett bolag stoppar inte de andra.
    const perCompany: Record<string, string> = {};
    const okKeys = new Set<string>();
    const companyJobs = new Map<string, Job>();
    await Promise.all(COMPANIES.map(async (c) => {
      try {
        const raws = await c.fetch();
        okKeys.add(c.key);
        let kept = 0;
        for (const r of raws) { const j = companyJob(c, r); if (j) { companyJobs.set(j.id, j); kept++; } }
        perCompany[c.name] = `${raws.length} hämtade, ${kept} relevanta`;
      } catch (e) { perCompany[c.name] = "FEL: " + (e as Error).message.slice(0, 60); }
    }));

    // Samma jobb på både Platsbanken och bolagets egen sida: behåll bolagets egen version
    const ownKeys = new Set([...companyJobs.values()].map((j) => norm(j.headline) + "|" + norm(j.employer || "").split(" ")[0]));
    for (const [id, j] of [...found]) if (ownKeys.has(norm(j.headline) + "|" + norm(j.employer || "").split(" ")[0])) found.delete(id);
    for (const [id, j] of companyJobs) found.set(id, j);

    const known = new Set(((await (await rest("ma_jobs?select=id&limit=10000")).json()) as { id: string }[]).map((r) => r.id));
    const fresh = [...found.values()].filter((j) => !known.has(j.id));

    // Städa jobb som bolaget tagit bort från sin karriärsida (bara för källor som svarade denna gång)
    const stale = [...known].filter((id) => { const k = id.split(":")[0]; return id.includes(":") && okKeys.has(k) && !found.has(id); });

    if (dry) {
      const by: Record<string, number> = {};
      for (const j of found.values()) by[`${j.category}/${j.level}`] = (by[`${j.category}/${j.level}`] || 0) + 1;
      return Response.json({ ok: true, dry: true, found: found.size, platsbanken: fromPlatsbanken, bolag: companyJobs.size, fresh: fresh.length, stale: stale.length, perBolag: perCompany, perKategoriNivå: by,
        studentvänliga: [...found.values()].filter((j) => j.level !== "erfaren" && j.id.includes(":")).map((j) => `${j.employer} | ${j.category}/${j.level} | ${j.headline.slice(0, 55)}`).slice(0, 40) });
    }

    if (stale.length) await rest(`ma_jobs?id=in.(${encodeURIComponent(stale.map((s) => `"${s}"`).join(","))})`, { method: "DELETE" });
    if (!fresh.length) return Response.json({ ok: true, found: found.size, fresh: 0, removed: stale.length, perBolag: perCompany });

    const ins = await rest("ma_jobs?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(fresh) });
    if (!ins.ok) { console.error("insert", ins.status, (await ins.text()).slice(0, 300)); return Response.json({ ok: false, error: "insert_failed" }, { status: 500 }); }
    const insertedIds = new Set(((await ins.json()) as { id: string }[]).map((r) => r.id));
    const inserted = fresh.filter((j) => insertedIds.has(j.id));

    let push = { sent: 0, dead: 0 };
    if (!firstRun && cfg.vapid_public && cfg.vapid_private) push = await sendPush(cfg, inserted);
    return Response.json({ ok: true, found: found.size, inserted: inserted.length, removed: stale.length, push, firstRun, perBolag: perCompany });
  } catch (e) {
    console.error("ma-jobs", (e as Error).message);
    return Response.json({ ok: false, error: "server" }, { status: 500 });
  }
});
