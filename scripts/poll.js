// Körs av GitHub Actions: hämtar M&A-nyheter, analyserar med Gemini, sparar i Supabase och skickar push.
import Parser from 'rss-parser';
import webpush from 'web-push';

const {
  GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY, INGEST_SECRET,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:lucas06.tekin@gmail.com',
  GEMINI_MODEL = 'gemini-2.5-flash-lite',
  MAX_PER_RUN = '20',
} = process.env;

for (const [k, v] of Object.entries({ GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY, INGEST_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY })) {
  if (!v) { console.error(`Saknar ${k}`); process.exit(1); }
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sb = async (path, opts = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const gn = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=en-US&gl=US&ceid=US:en`;
const FEEDS = [
  gn('"to acquire" OR "agrees to buy" OR "takeover" billion'),
  gn('merger announced OR "definitive agreement" acquisition'),
  gn('"all-cash deal" OR "buyout" OR "tender offer"'),
  gn('private equity take-private deal'),
  gn('Reuters mergers acquisitions'),
];
const KEYWORDS = /acqui|merger|merge|takeover|buyout|\bbuys?\b|to buy|bid for|tender offer|take-private/i;

const SYSTEM = `Du är en senior M&A-analytiker. Du får en nyhetsrubrik (och ev. ingress). Avgör om det handlar om en NY, konkret M&A-affär (förvärv, fusion, uppköpsbud, buyout).
Regler:
- is_deal=false för analyser, åsiktstexter, gamla affärer eller icke-M&A.
- value_usd_bn: affärsvärde i miljarder USD, endast om det står i texten, annars null.
- summary: 2-3 meningar på svenska (vad, pris, motiv).
- acquirer_reason / target_reason: 1 mening vardera på svenska. Bedöm om affären är bra eller dålig FÖR respektive bolag (pris/premie, strategisk logik, risk, skuldsättning).
- importance: heltal 1-5, där 5 är megaaffär med marknadspåverkan.
- Hitta aldrig på siffror som inte finns i texten. Detta är inte finansiell rådgivning.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_deal: { type: 'BOOLEAN' },
    acquirer: { type: 'STRING', nullable: true },
    target: { type: 'STRING', nullable: true },
    value_usd_bn: { type: 'NUMBER', nullable: true },
    sector: { type: 'STRING', nullable: true },
    status: { type: 'STRING', enum: ['announced', 'rumor', 'completed', 'rejected', 'other'] },
    summary: { type: 'STRING' },
    acquirer_verdict: { type: 'STRING', enum: ['good', 'neutral', 'bad'] },
    acquirer_reason: { type: 'STRING' },
    target_verdict: { type: 'STRING', enum: ['good', 'neutral', 'bad'] },
    target_reason: { type: 'STRING' },
    importance: { type: 'INTEGER' },
  },
  required: ['is_deal', 'status', 'summary', 'acquirer_verdict', 'acquirer_reason', 'target_verdict', 'target_reason', 'importance'],
};

async function analyze(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: `Rubrik: ${item.title}\nKälla: ${item.source}\nIngress: ${item.snippet || '-'}` }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.2 },
      }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(15000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    return JSON.parse(text);
  }
  throw new Error('Gemini: för många försök');
}

async function pushAll(deal, subs) {
  const icon = { good: '🟢', neutral: '🟡', bad: '🔴' };
  const payload = JSON.stringify({
    title: `${deal.acquirer || '?'} → ${deal.target || '?'}${deal.value_usd_bn ? ` ($${deal.value_usd_bn} mdr)` : ''}`,
    body: `${icon[deal.acquirer_verdict] || ''} Köpare  ${icon[deal.target_verdict] || ''} Mål\n${deal.summary}`,
    url: `./?deal=${deal.id}`,
  });
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    if ((s.min_importance || 1) > deal.importance) return;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
      else console.warn('Push-fel:', e.statusCode || e.message);
    }
  }));
  return dead;
}

const keyOf = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);

async function main() {
  const existing = await sb('ma_deals?select=id&limit=1');
  const firstRun = existing.length === 0; // första körningen fyller listan utan att skicka notiser

  const parser = new Parser({ timeout: 15000 });
  const items = [];
  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items.slice(0, 25)) {
        const parts = (it.title || '').split(' - ');
        const source = parts.length > 1 ? parts.pop() : '';
        items.push({ title: parts.join(' - '), source, link: it.link, snippet: (it.contentSnippet || '').slice(0, 300), date: it.isoDate || new Date().toISOString() });
      }
    } catch (e) { console.warn('Feed-fel:', e.message); }
  }

  const cands = items.filter((i) => i.title && KEYWORDS.test(i.title));
  const byKey = new Map(cands.map((i) => [keyOf(i.title), i]));
  const newKeys = await rpc('ma_mark_seen', { secret: INGEST_SECRET, keys: [...byKey.keys()] });
  const fresh = newKeys.map((k) => byKey.get(k)).slice(0, Number(MAX_PER_RUN));
  console.log(`${items.length} artiklar, ${cands.length} kandidater, ${fresh.length} nya att analysera`);
  if (!fresh.length) return;

  const subs = firstRun ? [] : await rpc('ma_get_subs', { secret: INGEST_SECRET });
  const deadAll = [];
  let added = 0;
  for (const it of fresh) {
    try {
      const a = await analyze(it);
      await sleep(4500); // håll oss under gratisgränsen för anrop/minut
      if (!a?.is_deal || a.status === 'other') continue;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const data = { id, ...a, link: it.link, source: it.source, headline: it.title, date: it.date };
      const dk = `${a.acquirer}|${a.target}`.toLowerCase();
      const inserted = await rpc('ma_insert_deal', { secret: INGEST_SECRET, p_id: id, p_key: dk, p_importance: a.importance, p_data: data });
      if (!inserted) continue;
      added++;
      if (subs.length) deadAll.push(...(await pushAll(data, subs)));
    } catch (e) { console.warn('Analysfel:', e.message); }
  }
  if (deadAll.length) await rpc('ma_remove_subs', { secret: INGEST_SECRET, endpoints: deadAll });
  console.log(`Klart: ${added} nya affärer${firstRun ? ' (första körningen, inga notiser)' : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
