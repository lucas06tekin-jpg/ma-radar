// Gemensam hjälp för notiser. Telefonen har en enda notisprenumeration som delas av 🔔 (affärer), nyheter och quizpåminnelser.
(() => {
  const C = window.CONFIG;
  const urlB64 = (b) => {
    const p = '='.repeat((4 - (b.length % 4)) % 4);
    const r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...r].map((c) => c.charCodeAt(0)));
  };
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;

  async function getReg() {
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) reg = await navigator.serviceWorker.register('sw.js');
    return reg;
  }

  window.PushUtil = {
    supported, isIos, standalone,
    // På iPhone fungerar notiser bara när appen ligger på hemskärmen
    blockedReason() {
      if (!supported) return 'Notiser stöds inte i den här webbläsaren.';
      if (isIos && !standalone) return 'På iPhone krävs att appen ligger på hemskärmen: tryck Dela i Safari, välj Lägg till på hemskärmen och öppna appen därifrån.';
      return null;
    },
    async currentEndpoint() {
      if (!supported) return null;
      try { const sub = await (await getReg()).pushManager.getSubscription(); return sub ? sub.endpoint : null; } catch { return null; }
    },
    // Ger en prenumeration (skapar den vid behov). Måste anropas direkt från ett knapptryck på iPhone.
    async ensure() {
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission !== 'granted') throw new Error('blocked');
      const reg = await getReg();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // ny prenumeration som inte kommer från 🔔: håll affärsnotiserna avstängda
        try { if (localStorage.getItem('ma.deals') == null) localStorage.setItem('ma.deals', '0'); } catch {}
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(C.VAPID_PUBLIC_KEY) });
      }
      return sub;
    },
  };
})();
