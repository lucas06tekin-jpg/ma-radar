// Hämtar hela artikeltexten: avkodar Google News-länken och plockar ut texten med Mozilla Readability.
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_CHARS = 8000;
const MIN_CHARS = 600;

const withTimeout = (ms) => AbortSignal.timeout(ms);

// Google News-länkar (news.google.com/rss/articles/ID) leder till en mellansida. Koden på sidan byts mot originaladressen.
export async function resolveGoogleNewsUrl(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  if (u.hostname !== 'news.google.com') return link;
  const id = u.pathname.split('/').pop();
  const page = await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'user-agent': UA }, signal: withTimeout(12000) });
  const html = await page.text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) return null;
  const inner = JSON.stringify([
    'garturlreq',
    [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id, Number(ts), sg,
  ]);
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
    body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]])),
    signal: withTimeout(12000),
  });
  const body = await res.text();
  try {
    const outer = JSON.parse(body.split('\n\n')[1]);
    return JSON.parse(outer[0][2])[1] || null;
  } catch { return null; }
}

// Returnerar { text, url } eller null om artikeln inte gick att läsa (betalvägg, JS-sida, fel).
export async function readArticle(link) {
  try {
    const url = await resolveGoogleNewsUrl(link);
    if (!url) return null;
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv,en;q=0.8' }, redirect: 'follow', signal: withTimeout(15000) });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
    const html = (await res.text()).slice(0, 2_000_000);
    const vc = new VirtualConsole(); // tysta CSS-varningar från jsdom
    const dom = new JSDOM(html, { url: res.url, virtualConsole: vc });
    const art = new Readability(dom.window.document).parse();
    const text = (art?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS) return null;
    return { text: text.slice(0, MAX_CHARS), url: res.url, title: art.title };
  } catch {
    return null;
  }
}
