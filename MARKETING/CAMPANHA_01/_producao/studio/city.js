// Cidade noturna estilizada (vetor gerado aqui; não é foto de nenhum lugar real)
(() => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  function layer(y, hMin, hMax, color, win, count, w0 = 60, w1 = 150) {
    let x = -40, out = '';
    for (let i = 0; i < count && x < 1120; i++) {
      const w = w0 + rnd() * (w1 - w0), h = hMin + rnd() * (hMax - hMin);
      out += `<rect x="${x.toFixed(0)}" y="${(y - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="${color}"/>`;
      if (win) for (let wy = y - h + 24; wy < y - 20; wy += 30) for (let wx = x + 14; wx < x + w - 18; wx += 26)
        if (rnd() < .28) out += `<rect class="win" x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="10" height="14" fill="${rnd() < .25 ? '#e7ff00' : '#ffd98a'}" opacity="${(.35 + rnd() * .55).toFixed(2)}"/>`;
      x += w + rnd() * 10;
    }
    return out;
  }
  window.cityLayers = {
    far: layer(1250, 160, 380, '#121218', false, 30, 50, 120),
    mid: layer(1300, 140, 420, '#16161d', true, 26),
    near: layer(1360, 90, 260, '#0d0d12', true, 22, 90, 200),
  };
})();
