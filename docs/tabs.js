// Flikhantering: Affärer, Quiz och Ordlista. Varje flik har ett <main id="view-NAMN"> och en hash i adressen.
(() => {
  const VIEWS = { deals: '', quiz: '#quiz', glossary: '#ordlista' };

  function show(view) {
    if (!(view in VIEWS)) view = 'deals';
    for (const v of Object.keys(VIEWS)) document.querySelector(`#view-${v}`).hidden = v !== view;
    document.querySelector('#filters').hidden = view !== 'deals';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    try { history.replaceState(null, '', VIEWS[view] || location.pathname + location.search); } catch {}
    if (view === 'quiz' && window.onQuizShow) window.onQuizShow();
    if (view === 'glossary' && window.onGlossaryShow) window.onGlossaryShow();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
  const start = Object.keys(VIEWS).find((v) => VIEWS[v] && VIEWS[v] === location.hash);
  if (start) show(start);
})();
