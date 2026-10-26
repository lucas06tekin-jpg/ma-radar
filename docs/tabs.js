// Flikhantering: Affärer, Quiz och Ordlista. Varje flik har ett <main id="view-NAMN"> och en hash i adressen.
(() => {
  const VIEWS = { deals: '', news: '#nyheter', jobs: '#jobb', quiz: '#quiz', glossary: '#ordlista', interview: '#intervju' };

  function show(view) {
    if (!(view in VIEWS)) view = 'deals';
    for (const v of Object.keys(VIEWS)) document.querySelector(`#view-${v}`).hidden = v !== view;
    document.querySelector('#filters').hidden = view !== 'deals';
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.view === view;
      t.classList.toggle('active', on);
      if (on && t.scrollIntoView) t.scrollIntoView({ inline: 'center', block: 'nearest' }); // flikraden kan rullas i sidled
    });
    try { history.replaceState(null, '', VIEWS[view] || location.pathname + location.search); } catch {}
    if (view === 'news' && window.onNewsShow) window.onNewsShow();
    if (view === 'jobs' && window.onJobsShow) window.onJobsShow();
    if (view === 'quiz' && window.onQuizShow) window.onQuizShow();
    if (view === 'glossary' && window.onGlossaryShow) window.onGlossaryShow();
    if (view === 'interview' && window.onInterviewShow) window.onInterviewShow();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
  const start = Object.keys(VIEWS).find((v) => VIEWS[v] && VIEWS[v] === location.hash);
  if (start) show(start);
})();
