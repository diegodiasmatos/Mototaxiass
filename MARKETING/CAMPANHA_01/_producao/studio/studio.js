(() => {
// Linha do tempo determinística: render(t) posiciona tudo para o instante t (segundos).
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const ease = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const out3 = x => 1 - Math.pow(1 - x, 3);
const back = x => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
/** Entra (sobe e aparece) em [a, a+d] e sai em [b, b+d]. */
function show(el, t, a, b, { d = .5, y = 40, s = 0, blur = 8 } = {}) {
  const i = out3(prog(t, a, a + d)), o = b == null ? 1 : 1 - ease(prog(t, b, b + d));
  const v = Math.min(i, o);
  el.style.opacity = v;
  const ty = (1 - i) * y - (1 - o) * y * .6, sc = 1 - s * (1 - v);
  el.style.transform = (el.dataset.base || '') + ` translateY(${ty}px) scale(${sc})`;
  el.style.filter = v < 1 ? `blur(${(1 - v) * blur}px)` : 'none';
  el.style.visibility = v <= 0.001 ? 'hidden' : 'visible';
}
/** Troca a imagem e espera ela estar pronta (nada de quadro em branco). */
const _imgCache = new Map();
function setImg(img, src) {
  if (img.dataset.src === src) return Promise.resolve();
  img.dataset.src = src;
  img.src = src;
  return img.decode().catch(() => {});
}
/** Quadro de uma gravação real no instante tc (segundos da gravação). */
function clipFrame(clip, tc) {
  const ts = clip.ts; let lo = 0, hi = ts.length - 1;
  if (tc <= 0) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= tc) lo = m; else hi = m - 1; }
  return lo;
}
window.studio = { clamp, prog, ease, out3, back, show, setImg, clipFrame };

})();
