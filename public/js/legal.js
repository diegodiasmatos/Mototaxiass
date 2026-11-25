/* Páginas legais.
   1) Textos aprovados (ex.: Termos de Uso em /legal/termos-de-uso.md) são
      exibidos EXATAMENTE como estão no arquivo: o código só converte a
      formatação (títulos, negrito, citação) e destaca os campos entre
      colchetes que ainda precisam ser preenchidos. Nenhuma palavra muda.
   2) Na Política de Privacidade preliminar, preenche os dados da empresa
      cadastrados na central e mostra o aviso de versão preliminar. */
'use strict';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Formatação em linha: **negrito** e destaque de [campo a preencher]. */
function inline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]/g, '<mark class="legal-fill" title="Campo a preencher">[$1]</mark>');
}

/** Markdown simples (títulos, parágrafos, citação, linha) → HTML. */
function renderMarkdown(md) {
  const out = [];
  for (const block of md.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    if (b === '---') { out.push('<hr>'); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(b);
    if (h && !b.includes('\n')) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (b.startsWith('>')) {
      out.push(`<blockquote class="legal-note">${inline(b.split('\n').map(l => l.replace(/^>\s?/, '')).join(' '))}</blockquote>`);
      continue;
    }
    out.push(`<p>${b.split('\n').map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

(async () => {
  const doc = document.getElementById('legal-doc');
  if (doc) {
    try {
      const r = await fetch(doc.dataset.src, { cache: 'no-cache' });
      if (!r.ok) throw new Error();
      doc.innerHTML = renderMarkdown(await r.text());
      const pending = doc.querySelectorAll('.legal-fill').length;
      if (pending) {
        doc.insertAdjacentHTML('afterbegin', `<div class="testbar" role="note">⚠️ Este documento ainda tem
          ${pending} campo(s) entre colchetes a preencher pela empresa antes da publicação.</div>`);
      }
    } catch {
      doc.innerHTML = `<p>Não foi possível carregar o texto agora. <a href="${doc.dataset.src}">Abrir o arquivo dos Termos</a>.</p>`;
    }
  }

  let d = {};
  try { d = await (await fetch('/api/legal', { cache: 'no-store' })).json(); } catch { /* sem rede */ }
  for (const el of document.querySelectorAll('[data-legal]')) {
    const v = d[el.dataset.legal];
    // pessoa física: com o responsável preenchido, CNPJ vazio quer dizer "não tem"
    if (!v && el.dataset.legal === 'company_cnpj' && d.company_name) { el.textContent = 'não se aplica'; continue; }
    el.textContent = v || '[a preencher]';
    if (!v) el.classList.add('legal-missing');
  }
  const ver = document.getElementById('legal-version');
  if (ver && d.version) ver.textContent = d.version;
  const warn = document.getElementById('legal-draft');
  if (warn) warn.hidden = !!d.reviewed;
})();
