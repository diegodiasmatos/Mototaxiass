const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2], B = 'http://localhost:4350';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HIDE = `#screenbar,#install-btn,.testbar,#quote-testbar,.push-ask{display:none!important}
.tap-dot{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(231,255,0,.35);border:2px solid rgba(231,255,0,.9);pointer-events:none;z-index:99999;animation:tapd .55s ease-out forwards}
@keyframes tapd{from{transform:scale(.4);opacity:1}to{transform:scale(1.25);opacity:0}}`;
const TAP = `document.addEventListener('pointerdown',e=>{const d=document.createElement('div');d.className='tap-dot';d.style.left=e.clientX+'px';d.style.top=e.clientY+'px';document.body.appendChild(d);setTimeout(()=>d.remove(),600)},true)`;
async function recorder(page, name) {
  const dir = `${OUT}/${name}`; fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async f => {
    const i = frames.length; frames.push(f.metadata.timestamp);
    fs.writeFileSync(`${dir}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1080, maxHeight: 2400, everyNthFrame: 1 });
  return async () => {
    await cdp.send('Page.stopScreencast');
    // arquivo de concatenação com a duração real de cada quadro
    let list = '';
    for (let i = 0; i < frames.length; i++) {
      const dur = i < frames.length - 1 ? Math.max(0.001, frames[i + 1] - frames[i]) : 0.5;
      list += `file 'f${String(i).padStart(5, '0')}.jpg'\nduration ${dur.toFixed(4)}\n`;
    }
    list += `file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`;
    fs.writeFileSync(`${dir}/list.txt`, list);
    console.log(name, frames.length, 'quadros', (frames[frames.length - 1] - frames[0]).toFixed(1), 's');
  };
}
(async () => {
  const b = await chromium.launch();
  const phone = { viewport: { width: 412, height: 892 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: false,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' };
  const mk = async geo => { const c = await b.newContext({ ...phone, permissions: ['geolocation'], geolocation: { ...geo, accuracy: 8 } }); await c.addInitScript(TAP); const p = await c.newPage(); return [c, p]; };
  const j = async (pg, m, path, d) => { const r = await pg.request.fetch(B + path, { method: m, data: d }); return { s: r.status(), d: await r.json().catch(() => ({})) }; };
  const prep = async p => { await p.addStyleTag({ content: HIDE }); await p.evaluate(() => document.querySelectorAll('.modal-backdrop,.toast').forEach(m => m.close ? m.close() : m.remove())); };
  // texto que só existe no ambiente local (pagamento de teste): some sempre que aparecer
  const noTestNotes = p => p.evaluate(() => { const fix = () => document.querySelectorAll('.pnote').forEach(n => { if (/teste/i.test(n.textContent)) n.remove(); }); fix(); new MutationObserver(fix).observe(document.body, { childList: true, subtree: true }); });

  const [cp, pp] = await mk({ latitude: -24.41450, longitude: -53.52050 });
  const [cd, dp] = await mk({ latitude: -24.40780, longitude: -53.51530 });
  await j(pp, 'POST', '/api/auth/register', { role: 'passenger', name: 'Bia Martins', phone: '44999990041', email: 'bia@demo.vairo', password: 'senha12345', accept_terms: true });
  await j(pp, 'POST', '/api/auth/login', { email: 'bia@demo.vairo', password: 'senha12345' });
  await j(dp, 'POST', '/api/auth/login', { email: 'carlos@demo.vairo', password: 'senha12345' });
  await dp.goto(B + '/motorista'); await sleep(2500); await prep(dp);
  if (!(await dp.evaluate(() => S.online))) { await dp.click('#online-toggle'); await sleep(2500); await prep(dp); }

  // CLIPE A: passageiro escolhe origem e destino e vê o trajeto e os preços
  await pp.goto(B + '/passageiro'); await sleep(3500); await prep(pp); await noTestNotes(pp);
  let stop = await recorder(pp, 'A_passageiro'); await sleep(1200);
  await pp.click('#btn-mylocation'); await sleep(2200);
  await pp.click('#in-dest'); await sleep(500);
  await pp.type('#in-dest', 'Jardim Paraná', { delay: 120 }); await sleep(2000);
  await pp.locator('#ac-dest button[data-i]').first().click(); await sleep(500);
  if (await pp.locator('.map-hint [data-asis]').count()) await pp.locator('.map-hint [data-asis]').click();
  await sleep(3500);
  await pp.click('#btn-quote'); await sleep(2200);
  await pp.locator('#quote-cards .cat-card').first().click(); await sleep(800);
  await pp.locator('#pay-options [data-pay="pix"]').click(); await sleep(1500);
  await stop();

  // CLIPE B: a gravação do mototaxista começa ANTES do pedido: a chamada chega, ele aceita
  stop = await recorder(dp, 'B_mototaxista'); await sleep(1500);
  await pp.click('#btn-request'); await sleep(1500);
  const ride = (await j(pp, 'GET', '/api/rides/active')).d.ride;
  await j(pp, 'POST', `/api/rides/${ride.id}/payment/test-approve`);
  await dp.locator('[data-accept], button:has-text("Aceitar")').first().waitFor({ timeout: 15000 });
  await sleep(2500);
  await dp.locator('[data-accept], button:has-text("Aceitar")').first().click(); await sleep(4500);
  await stop();
  await prep(pp);

  // CLIPE C: passageiro acompanha a moto chegando ao vivo
  await sleep(1500); await prep(pp); await pp.evaluate(() => window.scrollTo(0, 0));
  stop = await recorder(pp, 'C_acompanhar'); await sleep(1500);
  for (const [la, ln] of [[-24.4090, -53.5162], [-24.4102, -53.5172], [-24.4114, -53.5182], [-24.4126, -53.5192], [-24.4136, -53.5199], [-24.4141, -53.5203]]) {
    await cd.setGeolocation({ latitude: la, longitude: ln, accuracy: 8 }); await sleep(4300);
  }
  await sleep(1000); await stop();

  // CLIPE D: chegou — código de embarque
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/arrived`);
  stop = await recorder(pp, 'D_codigo'); await sleep(2500);
  await pp.evaluate(() => document.querySelector('#ride-boarding')?.scrollIntoView({ behavior: 'smooth', block: 'center' })); await sleep(3000);
  await stop();
  // encerra a corrida de demonstração
  const code = (await j(pp, 'GET', `/api/rides/${ride.id}`)).d.ride.boarding_code;
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/start`, { code }); await j(dp, 'POST', `/api/driver/rides/${ride.id}/complete`); await j(pp, 'POST', `/api/rides/${ride.id}/confirm`);
  await b.close();
})().catch(e => { console.error('FALHOU', e.message.split('\n')[0]); process.exit(1); });
