// Läser av en jobbannons-länk från valfri sajt (LinkedIn, karriärsidor m.fl.) och ger titel, arbetsgivare, ort och sista ansökningsdag.
// Kräver appens lösenord (så att inte vem som helst kan använda funktionen). Anropas direkt av appen.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UA = "Mozilla/5.0 (compatible; DinFinansApp/1.0)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const decode = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
const clean = (s: unknown) => decode(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// Blockera adresser som pekar på interna nät
function badHost(h: string): boolean {
  h = h.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6-adresser
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

const SITES: Record<string, string> = {
  "linkedin.com": "LinkedIn", "indeed.com": "Indeed", "arbetsformedlingen.se": "Platsbanken", "jobbsafari.se": "Jobbsafari", "monster.se": "Monster",
  "glassdoor.com": "Glassdoor", "teamtailor.com": "Teamtailor", "workable.com": "Workable", "lever.co": "Lever", "greenhouse.io": "Greenhouse",
  "jobylon.com": "Jobylon", "varbi.com": "Varbi", "reachmee.com": "ReachMee", "academicwork.se": "Academic Work", "studentconsulting.com": "StudentConsulting",
};
function siteOf(host: string): string {
  host = host.replace(/^www\./, "");
  for (const [d, n] of Object.entries(SITES)) if (host === d || host.endsWith("." + d)) return n;
  return host;
}

const meta = (html: string, key: string): string => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return tag ? clean(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "") : "";
};

function findJobPosting(node: unknown): Record<string, any> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findJobPosting(n); if (r) return r; } return null; }
  const o = node as Record<string, any>;
  const t = o["@type"];
  if ((typeof t === "string" && /jobposting/i.test(t)) || (Array.isArray(t) && t.some((x: string) => /jobposting/i.test(x)))) return o;
  if (o["@graph"]) return findJobPosting(o["@graph"]);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    const { pass, url } = await req.json();
    // Lösenordet kontrolleras av databasen (med spärr mot gissning)
    const login = await (await fetch(`${SUPABASE_URL}/rest/v1/rpc/ma_admin_login`, {
      method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_pass: pass }),
    })).json();
    if (!login.ok) return json({ ok: false, error: login.error || "forbidden" }, 403);

    let u: URL;
    try { u = new URL(String(url)); } catch { return json({ ok: false, error: "bad_url" }, 400); }
    if (!/^https?:$/.test(u.protocol) || badHost(u.hostname)) return json({ ok: false, error: "bad_url" }, 400);

    // Platsbanken är en JavaScript-sida utan läsbar HTML: fråga Arbetsförmedlingens öppna API i stället
    const pb = u.hostname.replace(/^www\./, "") === "arbetsformedlingen.se" && u.pathname.match(/\/platsbanken\/annonser\/(\d+)/);
    if (pb) {
      const r = await fetch(`https://jobsearch.api.jobtechdev.se/ad/${pb[1]}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const a = await r.json();
        const dl = String(a.application_deadline || "");
        return json({
          ok: true, site: "Platsbanken", url: u.toString(), structured: true,
          title: clean(a.headline).slice(0, 200), employer: clean(a.employer?.name || a.employer?.workplace).slice(0, 120),
          location: clean(a.workplace_address?.municipality || a.workplace_address?.city).slice(0, 80), deadline: /^\d{4}-\d{2}-\d{2}/.test(dl) ? dl.slice(0, 10) : "",
        });
      }
    }
    const res = await fetch(u.toString(), { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "sv,en;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
    const finalUrl = new URL(res.url || u.toString());
    if (badHost(finalUrl.hostname)) return json({ ok: false, error: "bad_url" }, 400);
    const site = siteOf(finalUrl.hostname);
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return json({ ok: true, partial: true, site, url: finalUrl.toString(), title: "", employer: "", location: "", deadline: "" });

    // läs högst ~400 kB
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let html = "", n = 0;
    while (n < 400_000) { const { done, value } = await reader.read(); if (done || !value) break; n += value.length; html += dec.decode(value, { stream: true }); }
    reader.cancel().catch(() => {});

    let title = "", employer = "", location = "", deadline = "";
    // 1) strukturerad annonsdata (schema.org/JobPosting), som många sajter publicerar
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const jp = findJobPosting(JSON.parse(m[1].trim()));
        if (!jp) continue;
        title = clean(jp.title);
        const org = jp.hiringOrganization;
        employer = clean(typeof org === "string" ? org : org?.name);
        const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
        const addr = loc?.address;
        location = clean([addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(", "));
        const vt = String(jp.validThrough || "");
        if (/^\d{4}-\d{2}-\d{2}/.test(vt)) deadline = vt.slice(0, 10);
        break;
      } catch { /* prova nästa block */ }
    }
    // 2) reservlösning: sidans rubrik
    if (!title) {
      title = meta(html, "og:title") || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      // LinkedIn: "Företag hiring Roll in Ort | LinkedIn"
      const li = title.match(/^(.*?)\s+(?:hiring|söker)\s+(.*?)\s+(?:in|i)\s+(.*?)(?:\s*\|.*)?$/i);
      if (li) { employer = employer || li[1]; title = li[2]; location = location || li[3]; }
      title = title.replace(/\s*[|–—-]\s*(LinkedIn|Indeed.*|Glassdoor.*|Platsbanken.*|Jobbsafari.*)$/i, "").trim();
    }
    if (!employer) employer = meta(html, "og:site_name") && site !== meta(html, "og:site_name") ? meta(html, "og:site_name") : "";
    return json({ ok: true, site, url: finalUrl.toString(), title: title.slice(0, 200), employer: employer.slice(0, 120), location: location.slice(0, 80), deadline, structured: !!deadline || !!employer });
  } catch (e) {
    console.error("ma-unfurl", (e as Error).message);
    return json({ ok: false, error: "server" }, 500);
  }
});
