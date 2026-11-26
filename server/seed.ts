/**
 * Importações automáticas de dados oficiais (pasta seed/), feitas UMA vez
 * quando o servidor liga em produção.
 *
 *  - seed/ibge-cnefe-2022-*.csv  → endereços oficiais do IBGE (números de casa,
 *    ruas e bairros que faltam), pela mesma rotina do cartão da central;
 *  - seed/locais-*.csv          → planilha de locais conferidos, pela mesma
 *    rotina de "Importar planilha de locais".
 *
 * As mesmas proteções da central valem aqui: nada é sobrescrito, nada é
 * duplicado, tudo fica na auditoria (como "sistema"). Cada arquivo é marcado
 * como importado pela impressão digital dele; se o arquivo mudar (nova versão),
 * ele é importado de novo, e só o que for novo entra.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getSetting, getSettingNum, setSetting, audit } from './db.ts';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');

function area() {
  return {
    lat: getSettingNum('center_lat'), lng: getSettingNum('center_lng'),
    radiusM: getSettingNum('coverage_radius_km') * 1000,
  };
}

/** CSV simples (; ou ,, com aspas) → objetos pelo cabeçalho normalizado. */
export function parsePlacesCsv(text: string): { name: string; tags: string | null; detail: string | null; lat: number; lng: number }[] {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  const head = (rows.shift() || []).map(norm);
  return rows.map(r => {
    const o: Record<string, string> = Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]));
    const street = o.logradouro || '', num = o.numero || '', bairro = o.bairro || '';
    const detail = [street && num ? `${street}, ${num}` : street, bairro].filter(Boolean).join(' – ');
    return {
      name: o.nome || '',
      tags: [o.categoria, o.palavras_chave].filter(Boolean).join(' ') || null,
      detail: detail || null,
      lat: Number(String(o.latitude || '').replace(',', '.')),
      lng: Number(String(o.longitude || '').replace(',', '.')),
    };
  });
}

export interface SeedReport { file: string; status: 'importado' | 'ja_importado' | 'erro'; detail: string }

/** Roda as importações pendentes. Uma falha não impede as outras e é tentada de novo na próxima subida. */
export async function runSeedImports(dir = SEED_DIR): Promise<SeedReport[]> {
  const out: SeedReport[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort(); } catch { return out; }
  // IBGE primeiro (ruas e números), depois os locais
  files.sort((a, b) => Number(!a.startsWith('ibge-')) - Number(!b.startsWith('ibge-')));
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f));
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const key = `seed:${f}`;
    if (getSetting(key) === sha) { out.push({ file: f, status: 'ja_importado', detail: sha }); continue; }
    try {
      let detail = '';
      if (f.startsWith('ibge-')) {
        const { importCnefe } = await import('./cnefe.ts');
        const r = importCnefe(new TextDecoder('windows-1252').decode(buf), area(), false);
        setSetting('cnefe_imported_at', String(Date.now()));
        detail = `${r.numeros.novos} número(s) de casa, ${r.ruas.novas} rua(s), ${r.localidades.novas} bairro(s)/loteamento(s)`;
        audit('sistema', 'cnefe_import', 'settings', undefined, `${detail} · arquivo ${f}`);
      } else if (f.startsWith('locais-')) {
        const { importManualPlaces } = await import('./address-base.ts');
        const res = importManualPlaces(parsePlacesCsv(buf.toString('utf8')), area(), false);
        const n = (s: string) => res.filter(r => r.status === s).length;
        detail = `${n('novo')} cadastrado(s) de ${res.length}; ${n('ja_existe')} já existiam; `
          + `${n('possivel_duplicata') + n('repetido_na_planilha')} possível(is) duplicata(s); ${n('fora_da_area') + n('invalido')} fora da área/inválido(s)`;
        audit('sistema', 'places_import', 'settings', undefined, `${detail} · fonte: ${f}`);
      } else {
        continue;
      }
      setSetting(key, sha);
      out.push({ file: f, status: 'importado', detail });
      console.log(`[importação automática] ${f}: ${detail}`);
    } catch (e: any) {
      out.push({ file: f, status: 'erro', detail: e?.message || String(e) });
      console.error(`[importação automática] ${f}: ${e?.message || e}`);
    }
  }
  return out;
}

/** Só no app publicado (APP_ENV=production) ou com SEED_IMPORTS=1; nunca nos testes. */
export function seedImportsEnabled(): boolean {
  if (process.env.SEED_IMPORTS === '0') return false;
  return process.env.APP_ENV === 'production' || process.env.SEED_IMPORTS === '1';
}

/** Total de números de casa por origem (para conferir depois da subida). */
export function seedStatus(): Record<string, number> {
  const by: Record<string, number> = {};
  for (const r of db.prepare('SELECT source, COUNT(*) c FROM address_points GROUP BY source').all() as any[]) by[r.source] = r.c;
  return by;
}
