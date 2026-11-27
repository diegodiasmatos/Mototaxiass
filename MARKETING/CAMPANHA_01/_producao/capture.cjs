const { chromium } = require('playwright');
const OUT = process.argv[2], B = 'http://localhost:4350';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HIDE = `#screenbar,#install-btn,.testbar,#quote-testbar,.push-ask{display:none!important}`;
(async () => {
  const b = await chromium.launch();
  const phone = { viewport: { width: 412, height: 892 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' };
  const mk = async (geo) => { const c = await b.newContext({ ...phone, permissions: ['geolocation'], geolocation: { ...geo, accuracy: 8 } }); const p = await c.newPage(); p.on('pageerror', e => console.log('ERRO', e.message)); return [c, p]; };
  const shot = async (p, name) => { await p.addStyleTag({ content: HIDE }).catch(() => {}); await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); await sleep(500); await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('ok', name); };
  const j = async (pg, m, path, d) => { const r = await pg.request.fetch(B + path, { method: m, data: d }); return { s: r.status(), d: await r.json().catch(() => ({})) }; };

  const [cp, pp] = await mk({ latitude: -24.41450, longitude: -53.52050 });
  const [cd, dp] = await mk({ latitude: -24.40780, longitude: -53.51530 });
  const ca = await b.newContext(); const ap = await ca.newPage();

  // tela de entrada (sem conta)
  await pp.goto(B + '/passageiro'); await sleep(1500); await shot(pp, 'p01_login');
  await pp.goto(B + '/'); await sleep(1500); await shot(pp, 'p00_inicio');

  // contas de demonstração
  await j(pp, 'POST', '/api/auth/register', { role: 'passenger', name: 'Ana Souza', phone: '44999990031', email: 'ana@demo.vairo', password: 'senha12345', accept_terms: true });
  const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3996, 7)]).toString('base64');
  await j(dp, 'POST', '/api/auth/register', { role: 'driver', name: 'Carlos Lima', cpf: '529.982.247-25', phone: '44999990032', email: 'carlos@demo.vairo', password: 'senha12345', accept_terms: true });
  await j(dp, 'POST', '/api/driver/apply', { birth_date: '1988-03-10', cnh_expiry: '2031-01-01', cnh_first_date: '2010-05-10', decl_cat_a_ear: true, address: 'Centro', moto_plate: 'BRA2E19', moto_brand: 'Honda', moto_model: 'CG 160 Fan', moto_year: '2023', moto_color: 'Vermelha', documents: { cnh: jpeg, crlv: jpeg, selfie: jpeg } });
  await j(ap, 'POST', '/api/auth/login', { email: 'adm@m.test', password: 'senha-admin-mkt' });
  const me = await j(dp, 'GET', '/api/me'); await j(ap, 'POST', `/api/admin/drivers/${me.d.user.id}/review`, { action: 'approve' });

  // mototaxista online
  await dp.goto(B + '/motorista'); await sleep(2500);
  await dp.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(m => m.close()));
  await dp.click('#online-toggle'); await sleep(3000);
  await dp.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(m => m.close()));
  await shot(dp, 'm01_online');

  // passageiro: início, origem pelo GPS, destino pela busca, trajeto por ruas
  await pp.goto(B + '/passageiro'); await sleep(3500);
  await pp.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(m => m.close()));
  await shot(pp, 'p02_home');
  await pp.click('#btn-mylocation'); await sleep(3000);
  await pp.fill('#in-dest', 'Jardim Paraná'); await sleep(2500);
  await shot(pp, 'p03_busca');
  await pp.locator('#ac-dest button[data-i]').first().click(); await sleep(500);
  if (await pp.locator('.map-hint [data-asis]').count()) await pp.locator('.map-hint [data-asis]').click();
  await sleep(5000);
  console.log('origem:', await pp.inputValue('#in-origin'), '| destino:', await pp.inputValue('#in-dest'), '|', (await pp.locator('#route-info').textContent()).replace(/\s+/g, ' ').trim());
  await pp.evaluate(() => window.scrollTo(0, 0)); await shot(pp, 'p04_rota');

  // preços e pagamento
  await pp.click('#btn-quote'); await sleep(2500);
  await pp.locator('#quote-cards .cat-card').first().click();
  await pp.locator('#pay-options [data-pay="pix"]').click(); await sleep(400);
  await pp.evaluate(() => window.scrollTo(0, 0)); await shot(pp, 'p05_precos');
  await pp.click('#btn-request'); await sleep(2500);
  const ride = (await j(pp, 'GET', '/api/rides/active')).d.ride;
  await j(pp, 'POST', `/api/rides/${ride.id}/payment/test-approve`); await sleep(3000);
  await pp.evaluate(() => document.querySelectorAll('.push-ask').forEach(x => x.remove()));
  await shot(pp, 'p06_procurando');

  // mototaxista recebe a chamada
  await sleep(2000);
  await shot(dp, 'm02_chamada');
  const acc = dp.locator('[data-accept], button:has-text("Aceitar")').first();
  if (await acc.count()) await acc.click(); else await j(dp, 'POST', `/api/driver/rides/${ride.id}/accept`);
  await sleep(3500); await shot(dp, 'm03_ir_ate_passageiro');

  // aproximação ao vivo
  for (const [la, ln] of [[-24.4100, -53.5170], [-24.4125, -53.5190], [-24.4138, -53.5200]]) { await cd.setGeolocation({ latitude: la, longitude: ln, accuracy: 8 }); await sleep(5200); }
  await pp.evaluate(() => { document.querySelectorAll('.toast,.push-ask').forEach(x => x.remove()); window.scrollTo(0, 0); });
  await shot(pp, 'p07_acompanhar');

  // chegou: código de embarque
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/arrived`); await sleep(3000);
  await pp.evaluate(() => { const el = document.querySelector('#ride-boarding'); if (el) el.scrollIntoView({ block: 'center' }); });
  await shot(pp, 'p08_codigo');

  // central de notificações
  await pp.evaluate(() => window.scrollTo(0, 0)); await pp.click('#btn-notifs'); await sleep(1500); await shot(pp, 'p09_notificacoes');
  await pp.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(m => m.close()));

  // viagem e fim
  const code = (await j(pp, 'GET', `/api/rides/${ride.id}`)).d.ride.boarding_code;
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/start`, { code }); await sleep(2000);
  await j(dp, 'POST', `/api/driver/rides/${ride.id}/complete`); await sleep(1500);
  await j(pp, 'POST', `/api/rides/${ride.id}/confirm`); await sleep(3500);
  await shot(pp, 'p10_avaliacao');

  // carteira do mototaxista
  await dp.reload(); await sleep(2500); await dp.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach(m => m.close()));
  await dp.click('.bottomnav [data-screen="screen-earnings"]'); await sleep(2000);
  await shot(dp, 'm04_carteira');
  await b.close();
})().catch(e => { console.error('FALHOU', e.message.split('\n')[0]); process.exit(1); });
