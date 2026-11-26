/**
 * Importação do CNEFE (Cadastro Nacional de Endereços para Fins Estatísticos,
 * IBGE, Censo 2022) — dados abertos oficiais com cada endereço do município,
 * número por número, com coordenadas.
 *
 * O que entra na base do VAIRO (marcado com source = 'ibge'):
 *  - números de casa (address_points): "Rua X, 123" passa a cair no ponto
 *    certo em vez do meio da rua;
 *  - ruas e localidades (bairros, loteamentos, áreas rurais) que o
 *    OpenStreetMap não tem, cada uma num endereço real dela.
 * O que NÃO entra: casas como "locais" com nome (o CNEFE não identifica
 * moradores e o VAIRO não publica residências). Estabelecimentos anotados
 * pelo recenseador ficam para a importação de planilha, com conferência.
 *
 * Nada que já existe é sobrescrito: ruas e bairros de mesmo nome ficam como
 * estão; número de casa já conhecido (OpenStreetMap ou confirmado por
 * passageiro) tem prioridade. A atualização do OpenStreetMap ("Atualizar
 * base") só apaga o que veio do OSM, então o que veio do IBGE permanece.
 */
import { db } from './db.ts';
import { haversineM } from './util.ts';
import { normalize, nameSimilarity } from './address-base.ts';

const SEP = ' · ';                         // mesmo separador da base (ruas de mesmo nome)
const PRECISE = new Set(['1', '2', '3']);  // coordenada do endereço (4–6 = quadra/localidade/setor)

/** Tipos de logradouro de verdade (o recenseador às vezes anota "Bairro", "Fazenda", "Rio"...). */
const STREET_TYPES = new Set(['RUA', 'AVENIDA', 'RAMAL', 'ESTRADA', 'TRAVESSA', 'RODOVIA', 'PROLONGAMENTO', 'VIELA',
  'PRACA', 'ALAMEDA', 'MARGINAL', 'LINHA', 'LIGACAO', 'CAMINHO', 'TRAVESSIA', 'RAMPA', 'LARGO', 'VIA']);
/** Localidade com cara de bairro/loteamento (as anotações livres, como "Ao lado do ramal", ficam de fora). */
const PLACE_PREFIX = /^(jardim|jd|conjunto|vila|parque|residencial|loteamento|condominio|centro|bairro|gleba|distrito|portal|recanto|chacaras|nucleo|cidade)\b/;
const MIN_STREET_ADDRESSES = 3;
const MIN_PLACE_ADDRESSES = 10;

const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
const UPPER = new Set(['br', 'pr', 'sc', 'sp', 'ii', 'iii', 'iv']);
export function titleCase(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).map((w, i) =>
    UPPER.has(w) ? w.toUpperCase() : (i && SMALL.has(w)) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Lê o CSV do CNEFE (separado por ;). */
function parse(csv: string): Record<string, string>[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = (lines.shift() || '').split(';').map(h => h.trim());
  for (const req of ['NOM_SEGLOGR', 'NUM_ENDERECO', 'LATITUDE', 'LONGITUDE', 'NV_GEO_COORD', 'DSC_LOCALIDADE']) {
    if (!head.includes(req)) throw new Error(`Arquivo não parece ser o CNEFE do IBGE (falta a coluna ${req}).`);
  }
  return lines.map(l => {
    const c = l.split(';');
    return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}

/** Endereço do grupo mais próximo do "meio" dele: um ponto real, nunca uma média no vazio. */
function representative(pts: { lat: number; lng: number }[]): { lat: number; lng: number } {
  const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const m = { lat: med(pts.map(p => p.lat)), lng: med(pts.map(p => p.lng)) };
  return pts.reduce((best, p) => haversineM(p.lat, p.lng, m.lat, m.lng) < haversineM(best.lat, best.lng, m.lat, m.lng) ? p : best);
}

export interface CnefeSummary {
  linhas: number; usadas: number;
  ignoradas: { coordenada_imprecisa: number; fora_da_area: number; sem_logradouro: number; tipo_de_logradouro_invalido: number };
  ruas: { novas: number; ja_existem: number; poucos_enderecos: number };
  localidades: { novas: number; ja_existem: number; nome_ambiguo: number; poucos_enderecos: number };
  numeros: { novos: number; ja_existem: number; sem_numero: number };
  exemplos: { ruas_novas: string[]; localidades_novas: string[] };
}

export function importCnefe(csv: string, area: { lat: number; lng: number; radiusM: number }, dryRun: boolean): CnefeSummary {
  const rows = parse(csv);
  const s: CnefeSummary = {
    linhas: rows.length, usadas: 0,
    ignoradas: { coordenada_imprecisa: 0, fora_da_area: 0, sem_logradouro: 0, tipo_de_logradouro_invalido: 0 },
    ruas: { novas: 0, ja_existem: 0, poucos_enderecos: 0 },
    localidades: { novas: 0, ja_existem: 0, nome_ambiguo: 0, poucos_enderecos: 0 },
    numeros: { novos: 0, ja_existem: 0, sem_numero: 0 },
    exemplos: { ruas_novas: [], localidades_novas: [] },
  };

  type Pt = { lat: number; lng: number; number: number; loc: string };
  const streets = new Map<string, { name: string; pts: Pt[] }>();        // chave: nome normalizado
  const locs = new Map<string, { name: string; pts: Pt[] }>();
  for (const r of rows) {
    const lat = Number(r.LATITUDE), lng = Number(r.LONGITUDE);
    if (!PRECISE.has(r.NV_GEO_COORD) || !Number.isFinite(lat) || !Number.isFinite(lng)) { s.ignoradas.coordenada_imprecisa++; continue; }
    if (haversineM(lat, lng, area.lat, area.lng) > area.radiusM) { s.ignoradas.fora_da_area++; continue; }
    const raw = [r.NOM_TIPO_SEGLOGR, r.NOM_TITULO_SEGLOGR, r.NOM_SEGLOGR].filter(Boolean).join(' ').trim();
    if (!r.NOM_SEGLOGR) { s.ignoradas.sem_logradouro++; continue; }
    if (!STREET_TYPES.has(normalize(r.NOM_TIPO_SEGLOGR || '').toUpperCase())) { s.ignoradas.tipo_de_logradouro_invalido++; continue; }
    s.usadas++;
    const name = titleCase(raw);
    const key = normalize(name);
    const num = /^\d+$/.test(r.NUM_ENDERECO) && r.DSC_MODIFICADOR.toUpperCase() !== 'SN' ? Number(r.NUM_ENDERECO) : 0;
    const loc = titleCase(r.DSC_LOCALIDADE || '');
    const p: Pt = { lat, lng, number: num, loc };
    if (!streets.has(key)) streets.set(key, { name, pts: [] });
    streets.get(key)!.pts.push(p);
    if (loc) {
      const lk = normalize(loc);
      if (!locs.has(lk)) locs.set(lk, { name: loc, pts: [] });
      locs.get(lk)!.pts.push(p);
    }
  }

  const t = Date.now();
  const ruasDaBase = (key: string) => db.prepare(`SELECT name, norm, lat, lng FROM local_addresses
    WHERE kind = 'rua' AND (norm = ? OR norm LIKE ? || '${SEP}%')`).all(key, key) as any[];
  // mesma rua com outro tipo ("Rua Itália" x "Avenida Itália") perto dos endereços dela
  const TYPE = /^(rua|avenida|travessa|alameda|rodovia|estrada|ramal|viela|praca|marginal|linha|caminho|prolongamento|ligacao|travessia|rampa|largo|via) /;
  const allRuas = db.prepare(`SELECT name, norm, lat, lng FROM local_addresses WHERE kind = 'rua'`).all() as any[];
  const outroTipo = (key: string, near: { lat: number; lng: number }) => {
    const core = key.replace(TYPE, '');
    if (core === key || core.length < 4) return [];
    return allRuas.filter(r => r.norm.split(SEP)[0].replace(TYPE, '') === core
      && haversineM(near.lat, near.lng, r.lat, r.lng) < 2000);
  };
  const allBairros = db.prepare(`SELECT name, norm, lat, lng FROM local_addresses WHERE kind = 'bairro'`).all() as any[];
  const insRua = db.prepare(`INSERT OR IGNORE INTO local_addresses (kind, name, norm, detail, tags, lat, lng, updated_at, source)
    VALUES ('rua', ?, ?, NULL, NULL, ?, ?, ?, 'ibge')`);
  const insLoc = db.prepare(`INSERT OR IGNORE INTO local_addresses (kind, name, norm, detail, tags, lat, lng, updated_at, source)
    VALUES ('bairro', ?, ?, NULL, NULL, ?, ?, ?, 'ibge')`);
  const hasPt = db.prepare('SELECT 1 FROM address_points WHERE street_norm = ? AND number = ?');
  const insPt = db.prepare(`INSERT OR IGNORE INTO address_points (street_norm, street_name, number, lat, lng, source, hits, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ibge', 1, ?)`);

  const added = new Set<string>();
  const run = () => {
    // ---- ruas: as que faltam entram num endereço real delas ----
    for (const [key, st] of streets) {
      let ruas = ruasDaBase(key);
      if (!ruas.length) ruas = outroTipo(key, representative(st.pts));
      if (ruas.length) s.ruas.ja_existem++;
      else if (st.pts.length < MIN_STREET_ADDRESSES) { s.ruas.poucos_enderecos++; continue; }
      else {
        const rp = representative(st.pts);
        s.ruas.novas++;
        if (s.exemplos.ruas_novas.length < 15) s.exemplos.ruas_novas.push(st.name);
        if (!dryRun) insRua.run(st.name, key, rp.lat, rp.lng, t);
        ruas = [{ name: st.name, norm: key, lat: rp.lat, lng: rp.lng }];
      }
      // ---- números de casa: cada endereço vai para a rua (desse nome) mais próxima ----
      const seen = new Set<number>();
      for (const p of st.pts) {
        if (!p.number) { s.numeros.sem_numero++; continue; }
        if (seen.has(p.number)) continue;            // apartamentos no mesmo número
        seen.add(p.number);
        const rua = ruas.map(r => ({ r, d: haversineM(p.lat, p.lng, r.lat, r.lng) })).sort((a, b) => a.d - b.d)[0].r;
        const pk = `${rua.norm}#${p.number}`;
        if (added.has(pk) || hasPt.get(rua.norm, p.number)) { s.numeros.ja_existem++; continue; }
        added.add(pk);                                // a prévia conta igual à gravação
        s.numeros.novos++;
        if (!dryRun) insPt.run(rua.norm, rua.name, p.number, p.lat, p.lng, t);
      }
    }
    // ---- localidades (bairros, loteamentos, áreas rurais) que faltam ----
    for (const [key, lc] of locs) {
      const rp0 = representative(lc.pts);
      // mesmo bairro com outra grafia ("Conjunto Habitacional Ivo Paul Muller" x "Conjunto Habitacional Ivo Muller")
      const exists = allBairros.some(b => b.norm === key
        || (nameSimilarity(b.name, lc.name) >= 0.66 && haversineM(rp0.lat, rp0.lng, b.lat, b.lng) < 1500));
      if (exists) { s.localidades.ja_existem++; continue; }
      if (!PLACE_PREFIX.test(key)) { s.localidades.nome_ambiguo++; continue; }
      if (lc.pts.length < MIN_PLACE_ADDRESSES) { s.localidades.poucos_enderecos++; continue; }
      const rp = representative(lc.pts);
      s.localidades.novas++;
      if (s.exemplos.localidades_novas.length < 30) s.exemplos.localidades_novas.push(lc.name);
      if (!dryRun) insLoc.run(lc.name, key, rp.lat, rp.lng, t);
    }
  };
  if (dryRun) run();
  else {
    db.exec('BEGIN');
    try { run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return s;
}
