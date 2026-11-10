import { db, getSettingNum } from './db.ts';
import { ApiError } from './util.ts';

export interface Fare {
  category: string;
  label: string;
  base_cents: number;
  included_m: number;
  per_km_cents: number;
}

export function getFare(category: string): Fare {
  const row = db.prepare('SELECT * FROM fare_settings WHERE category = ?').get(category) as any;
  if (!row) throw new ApiError(400, 'Categoria inválida.');
  return row as Fare;
}

export function allFares(): Fare[] {
  return db.prepare('SELECT * FROM fare_settings ORDER BY base_cents').all() as any[];
}

/**
 * Preço em centavos inteiros: base até `included_m`, depois valor por km
 * PROPORCIONAL à distância excedente (ex.: 5 km econômica = 550 + 3×200 = 1150).
 * Arredondamento: centavo mais próximo.
 */
export function computePriceCents(fare: Fare, distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0) throw new ApiError(400, 'Distância inválida.');
  const extraM = Math.max(0, distanceM - fare.included_m);
  return fare.base_cents + Math.round((extraM * fare.per_km_cents) / 1000);
}

export interface CommissionSplit {
  commission_pct: number;
  commission_cents: number;
  driver_cents: number;
}

/** Divide o valor da corrida entre plataforma e mototaxista (centavos inteiros). */
export function splitCommission(priceCents: number, pct?: number): CommissionSplit {
  const commission_pct = pct ?? getSettingNum('commission_pct');
  const commission_cents = Math.round(priceCents * commission_pct / 100);
  return { commission_pct, commission_cents, driver_cents: priceCents - commission_cents };
}
