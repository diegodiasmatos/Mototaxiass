/* Páginas legais: preenche os dados da empresa (cadastrados na central) e
   avisa quando o texto ainda não foi revisado por um advogado. */
'use strict';
(async () => {
  let d = {};
  try { d = await (await fetch('/api/legal', { cache: 'no-store' })).json(); } catch { /* sem rede */ }
  for (const el of document.querySelectorAll('[data-legal]')) {
    const v = d[el.dataset.legal];
    el.textContent = v || '[a preencher pela empresa]';
    if (!v) el.classList.add('legal-missing');
  }
  const ver = document.getElementById('legal-version');
  if (ver && d.version) ver.textContent = d.version.split('-').reverse().join('/');
  const warn = document.getElementById('legal-draft');
  if (warn) warn.hidden = !!d.reviewed;
})();
