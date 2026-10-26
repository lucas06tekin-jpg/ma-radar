// Skickar quizpåminnelser som webbpush. Anropas av databasen (pg_cron via ma_dispatch_reminders) med en hemlig header, aldrig direkt av appen.
// Driftsatt i Supabase-projektet som funktionen "ma-reminders" (verify_jwt av, hemligheten kontrolleras nedan).
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });

Deno.serve(async (req) => {
  try {
    const cfgRes = await rest("ma_config?id=eq.1&select=reminder_secret,vapid_public,vapid_private");
    const cfg = (await cfgRes.json())[0];
    const given = req.headers.get("x-reminder-secret");
    if (!cfg?.reminder_secret || !given || given !== cfg.reminder_secret) {
      return new Response("forbidden", { status: 403 });
    }
    if (!cfg.vapid_public || !cfg.vapid_private) {
      return Response.json({ ok: false, error: "vapid_missing" }, { status: 500 });
    }

    const { subs, title, body, url } = await req.json();
    if (!Array.isArray(subs)) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });

    webpush.setVapidDetails("mailto:lucas06.tekin@gmail.com", cfg.vapid_public, cfg.vapid_private);
    const payload = JSON.stringify({ title, body, url });

    const dead: string[] = [];
    const failed: { status?: number; message: string }[] = [];
    let sent = 0;
    await Promise.all(subs.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) dead.push(s.endpoint);
        else failed.push({ status, message: String((e as Error).message).slice(0, 200) });
      }
    }));

    // Prenumerationer som telefonen/webbläsaren har tagit bort städas bort så de inte försöks igen.
    if (dead.length) {
      const list = dead.map((d) => `"${d.replaceAll('"', "")}"`).join(",");
      await rest(`ma_reminders?endpoint=in.(${encodeURIComponent(list)})`, { method: "DELETE" });
    }
    if (failed.length) console.error("push-fel", JSON.stringify(failed));
    return Response.json({ ok: true, sent, dead: dead.length, failed: failed.length });
  } catch (e) {
    console.error("ma-reminders", (e as Error).message);
    return Response.json({ ok: false, error: "server" }, { status: 500 });
  }
});
