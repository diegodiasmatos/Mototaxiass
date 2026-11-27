// uso: node render.cjs <arquivo.html> <saida> [--preview t1,t2,...] [--size 1080x1920]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [file, out] = process.argv.slice(2);
const pv = process.argv.indexOf('--preview');
const sz = process.argv.indexOf('--size');
const [W, H] = (sz > 0 ? process.argv[sz + 1] : '1080x1920').split('x').map(Number);
(async () => {
  const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const p = await (await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
  p.on('pageerror', e => console.log('ERRO', e.message));
  await p.goto((file.includes('?') ? 'file://' + path.resolve(file.split('?')[0]) + '?' + file.split('?')[1] : 'file://' + path.resolve(file))); await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  if (pv > 0) {
    const ts = process.argv[pv + 1].split(',').map(Number);
    fs.mkdirSync(out, { recursive: true });
    for (const t of ts) { await p.evaluate(t => window.render && window.render(t), t); await p.waitForTimeout(60); await p.screenshot({ path: `${out}/t${String(t).replace('.', '_')}.png` }); }
    console.log('prévias', ts.length);
  } else if (!(await p.evaluate(() => typeof window.render === 'function'))) {
    await p.screenshot({ path: out, type: out.endsWith('.jpg') ? 'jpeg' : 'png', quality: out.endsWith('.jpg') ? 95 : undefined });
    console.log('imagem', out);
  } else {
    const dur = await p.evaluate(() => window.DURATION), fps = 30, n = Math.round(dur * fps);
    fs.mkdirSync(out, { recursive: true });
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      await p.evaluate(t => window.render(t), i / fps);
      await p.screenshot({ path: `${out}/${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 94 });
      if (i % 150 === 0) console.log(`${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
    console.log('quadros', n);
  }
  await b.close();
})().catch(e => { console.error('FALHOU', e.message); process.exit(1); });
