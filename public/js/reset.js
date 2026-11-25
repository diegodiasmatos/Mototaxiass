/* Criar nova senha pelo link de uso único enviado pela central.
   O código vem depois do "#" do link: não vai para o servidor em
   requisições comuns nem para registros de acesso. */
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  const msg = document.getElementById('reset-msg');
  const show = t => { msg.textContent = t; msg.hidden = false; };
  if (!token) show('Link incompleto. Abra o link exatamente como recebeu da central.');
  document.getElementById('form-reset').onsubmit = async e => {
    e.preventDefault();
    const a = document.getElementById('pw1').value, b = document.getElementById('pw2').value;
    if (a !== b) { show('As duas senhas não são iguais.'); return; }
    if (a.length < 8) { show('A senha precisa ter pelo menos 8 caracteres.'); return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: a }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { show(d.error || 'Não foi possível salvar. Tente de novo.'); return; }
      history.replaceState(null, '', '/redefinir-senha');
      e.target.hidden = true;
      document.getElementById('reset-ok').hidden = false;
    } catch {
      show('Sem conexão com o servidor. Verifique a internet e tente de novo.');
    } finally { btn.disabled = false; }
  };
})();
