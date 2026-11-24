/**
 * Versão do aplicativo (a parte que roda no celular: HTML, CSS, JS, imagens).
 *
 * É um resumo (hash) de todos os arquivos de public/. Mudou qualquer arquivo,
 * muda a versão — sem ninguém precisar lembrar de trocar número à mão. Ela vai:
 *  - para dentro do /sw.js: o navegador compara o sw.js byte a byte e, se mudou,
 *    instala o service worker novo, que troca o cache do app;
 *  - para a <meta name="app-version"> das páginas e para GET /api/version:
 *    a página aberta compara as duas e sabe que existe versão nova.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Hash curto do conteúdo de uma pasta (nomes + bytes de cada arquivo). */
export function computeVersion(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      h.update(path.relative(dir, full).split(path.sep).join('/'));
      h.update('\0');
      h.update(fs.readFileSync(full));
      h.update('\0');
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

let _version = '';
/** Versão calculada uma vez ao ligar o servidor (cada deploy reinicia o processo). */
export function appVersion(dir: string): string {
  if (!_version) _version = process.env.APP_VERSION?.trim() || computeVersion(dir);
  return _version;
}

/** Marca de versão que o service worker usa no nome do cache. */
const SW_VERSION_LINE = /const VERSION = '[^']*';/;
export function injectSwVersion(src: string, version: string): string {
  return src.replace(SW_VERSION_LINE, `const VERSION = 'amt-${version}';`);
}

/** Põe <meta name="app-version"> no <head> da página. */
export function injectHtmlVersion(html: string, version: string): string {
  if (html.includes('name="app-version"')) return html;
  return html.replace('</head>', `  <meta name="app-version" content="${version}">\n</head>`);
}
