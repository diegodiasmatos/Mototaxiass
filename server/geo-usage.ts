/**
 * Controle de consumo das APIs pagas do Google Maps Platform.
 *
 * O Google dá uma cota GRÁTIS por mês para cada SKU (reinicia no dia 1º, horário
 * do Pacífico). Aqui cada chamada é contada por mês e, ao chegar no teto
 * configurado (abaixo da cota grátis), o Google deixa de ser chamado até o mês
 * virar: a busca, os endereços e as rotas passam para o OpenStreetMap/OSRM e o
 * mapa para o OpenStreetMap. Assim um pico de uso não vira cobrança.
 *
 * Cotas grátis consultadas na documentação do Google (nov/2026; confira
 * sempre em developers.google.com/maps/billing-and-pricing/pricing):
 *  - Essentials (Dynamic Maps, Geocoding, Autocomplete, Place Details Essentials): 10.000/mês
 *  - Routes "Compute Routes" com motocicleta (TWO_WHEELER) é Enterprise: 1.000/mês
 *
 * Isto é uma proteção a mais: a garantia definitiva são as COTAS por API e o
 * ALERTA DE ORÇAMENTO configurados no Google Cloud (ver README).
 */
import { db, getSettingNum } from './db.ts';

export type GoogleApi = 'routes' | 'autocomplete' | 'details' | 'geocode' | 'maploads';

export const GOOGLE_APIS: { api: GoogleApi; label: string; setting: string; free: number; sku: string }[] = [
  { api: 'routes', label: 'Rotas (moto)', setting: 'google_cap_routes', free: 1000, sku: 'Compute Routes (Enterprise: TWO_WHEELER)' },
  { api: 'autocomplete', label: 'Busca por nome', setting: 'google_cap_autocomplete', free: 10000, sku: 'Places Autocomplete Requests (Essentials)' },
  { api: 'details', label: 'Posição do lugar escolhido', setting: 'google_cap_details', free: 10000, sku: 'Place Details Essentials' },
  { api: 'geocode', label: 'Endereço do GPS / toque no mapa', setting: 'google_cap_geocode', free: 10000, sku: 'Geocoding (Essentials)' },
  { api: 'maploads', label: 'Carregamentos do mapa', setting: 'google_cap_maploads', free: 10000, sku: 'Dynamic Maps (Essentials)' },
];

/** Mês de cobrança do Google (horário do Pacífico). */
export function billingMonth(t = Date.now()): string {
  const s = new Date(t).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' });
  return s.slice(0, 7).replace('/', '-');
}

export function usageOf(api: GoogleApi, month = billingMonth()): number {
  const r = db.prepare('SELECT count FROM api_usage WHERE month = ? AND api = ?').get(month, api) as any;
  return r ? r.count : 0;
}

export function capOf(api: GoogleApi): number {
  const def = GOOGLE_APIS.find(a => a.api === api)!;
  const v = getSettingNum(def.setting);
  return Number.isFinite(v) && v >= 0 ? v : Math.floor(def.free * 0.9);
}

/** Ainda dá para chamar o Google neste mês sem passar do teto? */
export function googleAllowed(api: GoogleApi): boolean {
  return usageOf(api) < capOf(api);
}

/** Conta uma chamada (feita ao Google, com ou sem sucesso: o Google cobra igual). */
export function countGoogle(api: GoogleApi, n = 1): void {
  db.prepare(`INSERT INTO api_usage (month, api, count) VALUES (?, ?, ?)
    ON CONFLICT(month, api) DO UPDATE SET count = count + excluded.count`).run(billingMonth(), api, n);
}

export function usageReport() {
  const month = billingMonth();
  return {
    month,
    apis: GOOGLE_APIS.map(a => {
      const used = usageOf(a.api, month), cap = capOf(a.api);
      return { api: a.api, label: a.label, sku: a.sku, used, cap, free: a.free, blocked: used >= cap,
        pct: cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 100 };
    }),
  };
}
