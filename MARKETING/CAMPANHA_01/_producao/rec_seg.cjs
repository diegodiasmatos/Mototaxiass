const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2], B = 'http://localhost:4350';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HIDE = `#screenbar,#install-btn,.testbar,#quote-testbar,.push-ask{display:none!important}
.tap-dot{position:fixed;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(231,255,0,.35);border:3px solid rgba(231,255,0,.95);pointer-events:none;z-index:99999;animation:tapd .6s ease-out forwards}
@keyframes tapd{from{transform:scale(.4);opacity:1}to{transform:scale(1.3);opacity:0}}`;
// toque visível; o texto que o app manda para o "compartilhar" do celular fica registrado;
// o link tel:190 não navega (não há discador neste navegador de teste)
const INIT = `
document.addEventListener('pointerdown',e=>{const d=document.createElement('div');d.className='tap-dot';d.style.left=e.clientX+'px';d.style.top=e.clientY+'px';document.body.appendChild(d);setTimeout(()=>d.remove(),650)},true);
Object.defineProperty(navigator,'share',{value: async d => { window.__shared = d; }, configurable: true});
document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href^="tel:"]'); if(a){e.preventDefault(); window.__tel=a.getAttribute('href');}},true);`;
async function recorder(page, name) {
  const dir = `${OUT}/${name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page); const frames = [];
  cdp.on('Page.screencastFrame', async f => { const i = frames.length; frames.push(f.metadata.timestamp);
    fs.writeFileSync(`${dir}/f${String(i).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64')); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1080, maxHeight: 2400, everyNthFrame: 1 });
  const marks = {}; const t0 = Date.now();
  return { mark: k => { marks[k] = (Date.now() - t0) / 1000; }, stop: async () => {
    await cdp.send('Page.stopScreencast');
    const ts = frames.map(x => +(x - frames[0]).toFixed(4));
    fs.writeFileSync(`${dir}/index.json`, JSON.stringify({ files: ts.map((_, i) => `f${String(i).padStart(5, '0')}.jpg`), ts, dur: ts[ts.length - 1] + .3, marks }));
    console.log(name, frames.length, 'quadros', ts[ts.length - 1].toFixed(1), 's', JSON.stringify(marks));
  } };
}
(async () => {
  const b = await chromium.launch();
  const phone = { viewport: { width: 412, height: 892 }, deviceScaleFactor: 2.5, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' };
  const mk = async geo => { const c = await b.newContext({ ...phone, permissions: ['geolocation'], geolocation: { ...geo, accuracy: 8 } }); await c.addInitScript(INIT); return [c, await c.newPage()]; };
  const j = async (pg, m, path, d) => { const r = await pg.request.fetch(B + path, { method: m, data: d }); return { s: r.status(), d: await r.json().catch(() => ({})) }; };
  const prep = async p => { await p.addStyleTag({ content: HIDE }); await p.evaluate(() => document.querySelectorAll('.modal-backdrop,.toast').forEach(m => m.close ? m.close() : m.remove())); };
  const [cp, pp] = await mk({ latitude: -24.41450, longitude: -53.52050 });
  const [cd, dp] = await mk({ latitude: -24.41440, longitude: -53.52040 });
  await j(pp, 'POST', '/api/auth/login', { email: 'bia@demo.vairo', password: 'senha12345' });
  await j(dp, 'POST', '/api/auth/login', { email: 'carlos@demo.vairo', password: 'senha12345' });
  await j(dp, 'POST', '/api/driver/online', { online: true }); await j(dp, 'POST', '/api/driver/location', { lat: -24.4144, lng: -53.5204, accuracy_m: 8 });
  // corrida de demonstração em andamento
  const q = await j(pp, 'POST', '/api/quotes', { origin: { lat: -24.4145, lng: -53.5205, text: 'Rua Polônia, Jardim Europa, Assis Chateaubriand' }, dest: { lat: -24.4296, lng: -53.5131, text: 'Jardim Paraná, Assis Chateaubriand' } });
  const ride = (await j(pp, 'POST', '/api/rides', { quote_id: q.d.quotes[0].id, payment_method: 'dinheiro' })).d.ride;
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/accept`); await j(dp, 'POST', `/api/driver/rides/${ride.id}/arrived`);
  const code = (await j(pp, 'GET', `/api/rides/${ride.id}`)).d.ride.boarding_code;
  console.log('início:', (await j(dp, 'POST', `/api/driver/rides/${ride.id}/start`, { code })).s);
  await j(dp, 'POST', '/api/driver/location', { lat: -24.4170, lng: -53.5190, accuracy_m: 8 });
  await pp.goto(B + '/passageiro'); await sleep(4000); await prep(pp);
  await pp.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
  const r = await recorder(pp, 'E_seguranca');
  await sleep(2200); r.mark('rolar');
  await pp.evaluate(() => document.querySelector('#ride-safety').scrollIntoView({ behavior: 'smooth', block: 'center' })); await sleep(2200);
  r.mark('emergencia'); await pp.locator('#ride-safety a[href^="tel:"]').click(); await sleep(2600);
  r.mark('compartilhar'); await pp.click('#btn-share-ride'); await sleep(2600);
  r.mark('fim'); await sleep(800);
  await r.stop();
  const shared = await pp.evaluate(() => window.__shared);
  const tel = await pp.evaluate(() => window.__tel);
  fs.writeFileSync(`${OUT}/E_seguranca/compartilhado.json`, JSON.stringify({ shared, tel }, null, 1));
  console.log('tel:', tel, '| texto compartilhado:', shared?.text);
  await pp.screenshot({ path: `${OUT}/E_seguranca/still.png` });
  // encerra a corrida de demonstração
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/complete`); await j(pp, 'POST', `/api/rides/${ride.id}/confirm`);
  await j(dp, 'POST', '/api/driver/online', { online: false });
  await b.close();
})().catch(e => { console.error('FALHOU', e.message.split('\n')[0]); process.exit(1); });
