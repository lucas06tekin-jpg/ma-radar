// Nyhetsflödet: hämtar rubriker från finanssajter, kollar betalvägg, låter Gemini skriva en svensk sammanfattning och
// bedöma hur viktig nyheten är, sparar i ma_news och skickar pushnotiser. Körs var 10:e minut av pg_cron (ma_news_tick).
// Driftsatt i Supabase som funktionen "ma-news" (verify_jwt av, hemligheten kontrolleras nedan).
import webpush from "npm:web-push@3.6.7";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (compatible; DinFinansApp/1.0)";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";

type Paywall = "free" | "paid" | "unknown";
type Src = { name: string; url: string; lang: "sv" | "en"; paywall: Paywall; check?: boolean; google?: boolean; filter?: boolean; max?: number };
type Item = {
  url: string; title: string; source: string; lang: "sv" | "en"; published: string; snippet: string; paywall: Paywall;
  check: boolean; google: boolean;
  summary_sv?: string | null; importance?: number; topic?: string | null; companies?: string[]; hidden?: boolean;
};

const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&hl=sv&gl=SE&ceid=SE:sv`;

// paywall = vad vi antar om källan; check = försök läsa av artikelsidans egen markering (isAccessibleForFree)
const SOURCES: Src[] = [
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", lang: "en", paywall: "free", check: true },
  { name: "CNBC", url: "https://www.cnbc.com/id/15839069/device/rss/rss.html", lang: "en", paywall: "free", check: true },
  { name: "CNBC", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html", lang: "en", paywall: "free", check: true },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", lang: "en", paywall: "unknown", check: true },
  { name: "WSJ", url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", lang: "en", paywall: "paid" },
  { name: "Financial Times", url: "https://www.ft.com/rss/home", lang: "en", paywall: "paid" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", lang: "en", paywall: "free" },
  { name: "The Guardian", url: "https://www.theguardian.com/uk/business/rss", lang: "en", paywall: "free" },
  { name: "Investing.com", url: "https://www.investing.com/rss/news.rss", lang: "en", paywall: "free" },
  { name: "Dagens industri", url: "https://www.di.se/rss", lang: "sv", paywall: "paid", check: true },
  { name: "DN Ekonomi", url: "https://www.dn.se/rss/ekonomi/", lang: "sv", paywall: "paid", check: true },
  { name: "Realtid", url: "https://www.realtid.se/feed", lang: "sv", paywall: "unknown", check: true },
  { name: "SvD", url: "https://www.svd.se/feed/articles.rss", lang: "sv", paywall: "unknown", check: true, filter: true, max: 25 },
  { name: "SVT Ekonomi", url: "https://www.svt.se/nyheter/ekonomi/rss.xml", lang: "sv", paywall: "free" },
  { name: "Aftonbladet", url: "https://rss.aftonbladet.se/rss2/small/pages/sections/ekonomi", lang: "sv", paywall: "unknown", check: true },
  { name: "Expressen", url: "https://feeds.expressen.se/ekonomi", lang: "sv", paywall: "unknown", check: true },
  { name: "Riksbanken", url: "https://www.riksbank.se/sv/rss/nyheter/", lang: "sv", paywall: "free" },
];
const PER_SOURCE = 8;          // högst så många nya per källa och körning
const BATCH = 40;              // högst så många nya som skickas till Gemini per körning
const MAX_AGE_MS = 36 * 3600e3; // äldre nyheter hoppas över
const PUSH_MAX_AGE_MS = 3 * 3600e3; // notis bara för nyheter yngre än så

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: true, trimValues: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : v && typeof v === "object" ? text((v as Record<string, unknown>)["#text"]) : "");
const decode = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
const clean = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function normUrl(u: string, google: boolean) {
  if (google) return u;
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|cid$|mod$|ref)/i.test(k)) x.searchParams.delete(k);
    x.hash = "";
    return x.toString();
  } catch { return u; }
}

const diag: Record<string, string> = {};
async function fetchFeed(src: Src): Promise<Item[]> {
  const label = src.name + (src.google ? " (gn)" : "") + " " + src.url.slice(-18);
  try {
    const headers: Record<string, string> = { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml, */*" };
    if (src.google) headers.cookie = "CONSENT=YES+cb; SOCS=CAI"; // hoppar över EU-samtyckessidan
    const res = await fetch(src.url, { headers, signal: AbortSignal.timeout(9000), redirect: "follow" });
    if (!res.ok) { diag[label] = `HTTP ${res.status}`; return []; }
    const xml = await res.text();
    const doc = parser.parse(xml);
    const raw = asArray<Record<string, unknown>>(doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item ?? doc?.feed?.entry);
    const out: Item[] = [];
    for (const r of raw) {
      let title = clean(text(r.title));
      let link = text(r.link);
      if (!link && r.link && typeof r.link === "object") {
        const ls = asArray<Record<string, string>>(r.link as Record<string, string>);
        link = (ls.find((l) => l["@_rel"] === "alternate") || ls[0])?.["@_href"] || "";
      }
      if (!title || !link) continue;
      let source = src.name;
      if (src.google) { // Google News lägger "Rubrik - Källa" i titeln
        const m = title.match(/^(.*)\s-\s([^-]{2,40})$/);
        if (m) { if (/forum/i.test(m[2])) continue; title = m[1].trim(); } // hoppa över inlägg från diskussionsforum
      }
      const when = new Date(text(r.pubDate) || text(r.published) || text(r.updated) || text(r["dc:date"]) || Date.now());
      const published = isNaN(+when) ? new Date() : when;
      if (Date.now() - +published > MAX_AGE_MS || +published > Date.now() + 3600e3) continue;
      const snippet = src.google ? "" : clean(text(r.description) || text(r.summary) || text(r["content:encoded"])).slice(0, 320);
      out.push({ url: normUrl(link, !!src.google), title, source, lang: src.lang, published: published.toISOString(), snippet, paywall: src.paywall, check: !!src.check, google: !!src.google });
    }
    out.sort((a, b) => +new Date(b.published) - +new Date(a.published));
    diag[label] = `HTTP ${res.status}, ${raw.length} poster, ${out.length} färska${raw.length ? "" : ", början: " + xml.slice(0, 80).replace(/\s+/g, " ")}`;
    return out.slice(0, src.max ?? PER_SOURCE);
  } catch (e) {
    diag[label] = "fel: " + (e as Error).message.slice(0, 80);
    console.warn("feed-fel", src.name, (e as Error).message);
    return [];
  }
}

// Läser de första ~200 kB av artikelsidan och letar efter publicerarens egen markering av betalvägg.
async function checkPaywall(it: Item): Promise<Paywall> {
  if (/cnbc\.com\/pro\//i.test(it.url)) return "paid";
  if (!it.check || it.google) return it.paywall;
  try {
    const res = await fetch(it.url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (!res.ok || !res.body) return it.paywall;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", n = 0;
    while (n < 200_000) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      n += value.length;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/"isAccessibleForFree"\s*:\s*"?(true|false)"?/i);
      if (m) { reader.cancel().catch(() => {}); return m[1].toLowerCase() === "false" ? "paid" : "free"; }
    }
    reader.cancel().catch(() => {});
  } catch { /* behåll standardantagandet */ }
  return it.paywall;
}

async function pool<T, R>(arr: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); }
  }));
  return out;
}

const TOPICS = ["marknad", "bolag", "makro", "räntor", "affärer", "råvaror", "krypto", "svenskt", "övrigt"];
const SYSTEM = `Du är nyhetsredaktör för en svensk finansapp. Du får numrerade rubriker (ibland med ingress) från finansmedier.
För varje rubrik:
- relevant: true om den handlar om ekonomi, finansmarknader, bolag, räntor/centralbanker, makroekonomi, råvaror, krypto eller företagsaffärer. false för sport, kändisar, vanlig inrikespolitik och annat utan ekonomisk vinkel.
- summary_sv: 1-2 meningar på svenska (högst 220 tecken) om vad som hänt och varför det spelar roll. Utgå ENDAST från rubriken/ingressen. Hitta aldrig på siffror eller detaljer som inte står där. Är underlaget tunt, skriv en kort neutral omformulering.
- importance: heltal 1-5. 5 = marknadsrörande eller mycket stort (räntebesked, kraftiga börsrörelser, jätteaffär, stor nyhet från ett av världens största bolag), 4 = viktig bolags- eller makronyhet, 3 = vanlig nyhet av intresse, 2 = rutinnyhet, 1 = marginell.
- topic: en av ${TOPICS.join(", ")}.
- companies: bolag nyheten handlar om (högst 3, tom lista om inget särskilt).
Detta är inte finansiell rådgivning.`;

async function summarize(items: Item[], key: string): Promise<boolean> {
  const prompt = items.map((it, i) => `[${i}] (${it.source}, ${it.lang === "sv" ? "svenska" : "engelska"}) ${it.title}${it.snippet ? " — " + it.snippet : ""}`).join("\n");
  const schema = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        i: { type: "INTEGER" }, relevant: { type: "BOOLEAN" }, summary_sv: { type: "STRING" }, importance: { type: "INTEGER" },
        topic: { type: "STRING", enum: TOPICS }, companies: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["i", "relevant", "summary_sv", "importance", "topic", "companies"],
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 8000)); continue; }
    if (!res.ok) { console.error("gemini", res.status, (await res.text()).slice(0, 300)); return false; }
    try {
      const j = await res.json();
      const arr = JSON.parse(j.candidates?.[0]?.content?.parts?.map((p: { text: string }) => p.text).join("") || "[]");
      for (const r of arr) {
        const it = items[r.i];
        if (!it) continue;
        it.hidden = r.relevant === false;
        it.summary_sv = String(r.summary_sv || "").slice(0, 400) || null;
        it.importance = Math.min(5, Math.max(1, Number(r.importance) || 2));
        it.topic = TOPICS.includes(r.topic) ? r.topic : "övrigt";
        it.companies = Array.isArray(r.companies) ? r.companies.slice(0, 3).map((c: string) => String(c).slice(0, 60)) : [];
      }
      return true;
    } catch (e) { console.error("gemini-parse", (e as Error).message); return false; }
  }
  return false;
}

async function sendPush(cfg: { vapid_public: string; vapid_private: string }, inserted: Item[]) {
  const subsRes = await rest("ma_news_subs?enabled=eq.true&select=endpoint,p256dh,auth,min_importance,hide_paid");
  const subs: { endpoint: string; p256dh: string; auth: string; min_importance: number; hide_paid: boolean }[] = await subsRes.json();
  if (!subs.length) return { sent: 0, dead: 0 };
  webpush.setVapidDetails("mailto:lucas06.tekin@gmail.com", cfg.vapid_public, cfg.vapid_private);
  const recent = inserted.filter((it) => !it.hidden && Date.now() - +new Date(it.published) < PUSH_MAX_AGE_MS);
  const dead: string[] = [];
  let sent = 0;
  for (const s of subs) {
    const cand = recent
      .filter((it) => (it.importance ?? 2) >= s.min_importance && !(s.hide_paid && it.paywall === "paid"))
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    if (!cand.length) continue;
    const msgs = cand.length <= 3
      ? cand.map((it) => ({ title: `${it.importance === 5 ? "🚨" : "📰"} ${it.source}${it.paywall === "paid" ? " 🔒" : ""}`, body: it.summary_sv || it.title }))
      : [{ title: `📰 ${cand.length} nya nyheter`, body: cand.slice(0, 3).map((it) => it.title).join(" · ") }];
    for (const m of msgs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...m, url: "./#nyheter" }));
        sent++;
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) { dead.push(s.endpoint); break; }
        console.error("push-fel", st, String((e as Error).message).slice(0, 120));
      }
    }
  }
  if (dead.length) await rest(`ma_news_subs?endpoint=in.(${encodeURIComponent(dead.map((d) => `"${d.replaceAll('"', "")}"`).join(","))})`, { method: "DELETE" });
  return { sent, dead: dead.length };
}

Deno.serve(async (req) => {
  try {
    const cfg = (await (await rest("ma_config?id=eq.1&select=reminder_secret,vapid_public,vapid_private,gemini_key")).json())[0];
    const given = req.headers.get("x-reminder-secret");
    if (!cfg?.reminder_secret || !given || given !== cfg.reminder_secret) return new Response("forbidden", { status: 403 });
    const geminiKey: string | undefined = Deno.env.get("GEMINI_API_KEY") || cfg.gemini_key || undefined;
    const dry = !!((await req.json().catch(() => ({}))) as { dry?: boolean }).dry; // provläge: hämta och kolla betalvägg, spara inget

    // Första körningen fyller listan utan att skicka notiser
    const firstRun = ((await (await rest("ma_news?select=id&limit=1")).json()) as unknown[]).length === 0;

    const all = (await Promise.all(SOURCES.map(fetchFeed))).flat();
    const since = new Date(Date.now() - 3 * 24 * 3600e3).toISOString();
    const known = new Set(((await (await rest(`ma_news?select=url&created_at=gte.${since}&limit=5000`)).json()) as { url: string }[]).map((r) => r.url));
    const seenNow = new Set<string>();
    const fresh = all
      .filter((it) => !known.has(it.url) && !seenNow.has(it.url) && seenNow.add(it.url))
      .sort((a, b) => +new Date(b.published) - +new Date(a.published))
      .slice(0, BATCH);
    if (!fresh.length) return Response.json({ ok: true, feeds: SOURCES.length, found: all.length, fresh: 0 });

    // Betalvägg: publicerarens egen markering om den går att läsa, annars antagandet för källan
    const walls = await pool(fresh, 8, checkPaywall);
    fresh.forEach((it, i) => { it.paywall = walls[i]; });

    if (dry) {
      const per: Record<string, number> = {};
      all.forEach((it) => { per[it.source] = (per[it.source] || 0) + 1; });
      return Response.json({ ok: true, dry: true, found: all.length, fresh: fresh.length, perSource: per, diag, hasKey: !!geminiKey,
        sample: fresh.slice(0, 40).map((i) => `${i.source} | ${i.paywall} | ${i.title.slice(0, 60)}`) });
    }
    // Utan nyckel sparas inget (annars fylls listan med nyheter utan sammanfattning)
    if (!geminiKey) return Response.json({ ok: false, error: "no_gemini_key", fresh: fresh.length });
    const summarized = await summarize(fresh, geminiKey);
    if (!summarized) return Response.json({ ok: false, error: "summarize_failed", fresh: fresh.length }); // försöker igen nästa körning

    const rows = fresh.map((it) => ({
      url: it.url, title: it.title.slice(0, 400), source: it.source, lang: it.lang, published: it.published, snippet: it.snippet || null,
      summary_sv: summarized ? it.summary_sv ?? null : null, importance: it.importance ?? 2, topic: it.topic ?? null,
      companies: it.companies ?? [], paywall: it.paywall, hidden: !!it.hidden,
    }));
    const ins = await rest("ma_news?on_conflict=url", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(rows) });
    if (!ins.ok) { console.error("insert", ins.status, (await ins.text()).slice(0, 300)); return Response.json({ ok: false, error: "insert_failed" }, { status: 500 }); }
    const inserted = (await ins.json()) as { url: string }[];
    const insertedSet = new Set(inserted.map((r) => r.url));

    let push = { sent: 0, dead: 0 };
    if (!firstRun && cfg.vapid_public && cfg.vapid_private) push = await sendPush(cfg, fresh.filter((it) => insertedSet.has(it.url)));
    return Response.json({ ok: true, found: all.length, fresh: fresh.length, inserted: inserted.length, summarized, hidden: fresh.filter((i) => i.hidden).length, push, firstRun });
  } catch (e) {
    console.error("ma-news", (e as Error).message);
    return Response.json({ ok: false, error: "server" }, { status: 500 });
  }
});
