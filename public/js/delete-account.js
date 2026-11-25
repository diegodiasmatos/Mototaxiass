/* Pedido de exclusão de conta pela web (sem login). */
'use strict';
(() => {
  const f = document.getElementById('form-del');
  const msg = document.getElementById('del-msg');
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    msg.hidden = true;
    try {
      const r = await fetch('/api/account-deletion', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('del-email').value.trim(),
          reason: document.getElementById('del-reason').value,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Não foi possível enviar agora. Tente de novo.');
      f.hidden = true;
      const ok = document.getElementById('del-ok');
      ok.textContent = d.message;
      ok.hidden = false;
    } catch (err) {
      msg.textContent = err.message === 'Failed to fetch'
        ? 'Sem conexão com o servidor. Verifique a internet e tente de novo.' : err.message;
      msg.hidden = false;
    } finally { btn.disabled = false; }
  };
})();
