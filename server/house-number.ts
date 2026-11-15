/**
 * Localização de número de casa ("Avenida Tupãssi 6161").
 *
 * A base local (OpenStreetMap) conhece as ruas da cidade, mas quase nenhum
 * número de casa. Quando o número pedido não tem ponto confirmado, este
 * módulo pergunta a um serviço que conhece numeração:
 *
 *  1º Google Geocoding API — a melhor cobertura de numeração no Brasil.
 *     Opcional: precisa de chave (central → 🗺️ Mapas, `GOOGLE_GEOCODING_KEY`).
 *  2º Mapbox Geocoding — usa o token do Mapbox já configurado.
 *
 * Só vale resposta em nível de ENDEREÇO, com o mesmo número pedido e perto
 * da rua que a base conhece. "Achei só a rua" não serve: aí o app continua
 * pedindo ao passageiro o toque no ponto exato, em vez de fingir precisão.
 *
 * Resultados do Google ficam em cache por no máximo 30 dias (limite dos
 * termos da plataforma para latitude/longitude); os do Mapbox não são
 * guardados (termos do modo temporário).
 */
import { getCredential, getSetting, getSettingNum } from './db.ts';
import { haversineM } from './util.ts';
import { cacheGet, cacheSet, mapboxEnabled, mapboxAddress } from './mapbox.ts';

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_CACHE_KIND = 'numero_google';
const GOOGLE_CACHE_MAX_MS = 30 * 24 * 3600_000;

/** Um endereço só é aceito se cair a menos disso do ponto da rua na base. */
const MAX_FROM_STREET_M = 7000;

export interface HouseLocation {
  lat: number;
  lng: number;
  provider: 'google' | 'mapbox';
}

export function googleGeocodingKey(): string | null {
  return getCredential('GOOGLE_GEOCODING_KEY');
}
export function googleGeocodingEnabled(): boolean {
  return !!googleGeocodingKey() && getSetting('maps_provider') !== 'osm';
}

/** "Assis Chateaubriand - PR" → { city: "Assis Chateaubriand", uf: "PR" } */
function cityParts(): { city: string; uf: string } {
  const [city, uf] = getSetting('city_name').split('-').map(x => x.trim());
  return { city: city || '', uf: uf || '' };
}

/**
 * Consulta o Google. Lança erro em falha de rede/chave (quem chama decide);
 * devolve nulo quando o Google não tem o número.
 */
export async function googleAddress(street: string, number: number):
  Promise<{ lat: number; lng: number } | null> {
  const key = googleGeocodingKey();
  if (!key) return null;
  const { city, uf } = cityParts();

  const parts = [street.toLowerCase().trim(), number, city, uf];
  const cached = cacheGet<{ lat: number; lng: number } | { none: true }>(GOOGLE_CACHE_KIND, parts);
  if (cached) return 'none' in cached ? null : cached;

  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const km = Math.min(50, getSettingNum('coverage_radius_km'));
  const dLat = km / 111.32, dLng = km / (111.32 * Math.cos(cLat * Math.PI / 180));

  const url = new URL(GOOGLE_GEOCODE_URL);
  url.searchParams.set('address', `${street}, ${number}, ${city}${uf ? ` - ${uf}` : ''}, Brasil`);
  url.searchParams.set('components', 'country:BR');
  url.searchParams.set('bounds', `${cLat - dLat},${cLng - dLng}|${cLat + dLat},${cLng + dLng}`);
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('region', 'br');
  url.searchParams.set('key', key);

  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Google Geocoding ${r.status}`);
  const d: any = await r.json();
  if (d.status !== 'OK' && d.status !== 'ZERO_RESULTS') {
    // REQUEST_DENIED, OVER_QUERY_LIMIT…: problema de chave/cota, não de endereço
    throw new Error(`Google Geocoding: ${d.status}${d.error_message ? ` — ${String(d.error_message).slice(0, 160)}` : ''}`);
  }

  const ttl = Math.min(GOOGLE_CACHE_MAX_MS, getSettingNum('cache_route_hours') * 3600_000 || GOOGLE_CACHE_MAX_MS);
  for (const res of d.results ?? []) {
    // nível de endereço: telhado ou interpolado na quadra — não "centro da rua"
    const precise = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(res.geometry?.location_type);
    const isAddress = (res.types ?? []).some((t: string) => ['street_address', 'premise', 'subpremise'].includes(t));
    const num = (res.address_components ?? [])
      .find((c: any) => (c.types ?? []).includes('street_number'))?.long_name;
    if (!precise || !isAddress || parseInt(String(num), 10) !== number) continue;
    const lat = Number(res.geometry.location?.lat), lng = Number(res.geometry.location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    cacheSet(GOOGLE_CACHE_KIND, parts, { lat, lng }, ttl);
    return { lat, lng };
  }
  // "não tem" também vai para o cache (curto): não paga a mesma pergunta de novo
  cacheSet(GOOGLE_CACHE_KIND, parts, { none: true }, Math.min(ttl, 24 * 3600_000));
  return null;
}

/**
 * Procura a posição real do número. `near` é o ponto da rua na base local:
 * resposta longe dele é de outra rua/cidade com nome parecido e é recusada.
 * Nunca lança: sem serviço configurado, sem rede ou sem resultado → nulo.
 */
export async function locateHouseNumber(street: string, number: number,
  near: { lat: number; lng: number }): Promise<HouseLocation | null> {
  if (!Number.isInteger(number) || number <= 0) return null;
  const ok = (p: { lat: number; lng: number } | null): p is { lat: number; lng: number } =>
    !!p && haversineM(p.lat, p.lng, near.lat, near.lng) <= MAX_FROM_STREET_M;

  if (googleGeocodingEnabled()) {
    try {
      const g = await googleAddress(street, number);
      if (ok(g)) return { ...g, provider: 'google' };
    } catch { /* tenta o Mapbox */ }
  }
  if (mapboxEnabled()) {
    try {
      const m = await mapboxAddress(street, number);
      if (ok(m)) return { ...m, provider: 'mapbox' };
    } catch { /* fica sem */ }
  }
  return null;
}

/** Diagnóstico da central: a chave do Google responde? */
export async function testGoogleGeocoding(): Promise<{ item: string; ok: boolean; detail: string }> {
  const item = 'Números de casa (Google Geocoding)';
  if (!googleGeocodingKey()) {
    return {
      item, ok: false,
      detail: 'Chave não configurada — números de casa dependem do Mapbox ou do ajuste do pino pelo passageiro.',
    };
  }
  try {
    const { city, uf } = cityParts();
    const url = new URL(GOOGLE_GEOCODE_URL);
    url.searchParams.set('address', `${city}${uf ? ` - ${uf}` : ''}, Brasil`);
    url.searchParams.set('key', googleGeocodingKey()!);
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const d: any = await r.json();
    if (d.status === 'OK') return { item, ok: true, detail: 'Chave aceita: o Google respondeu para a cidade atendida.' };
    return {
      item, ok: false,
      detail: `O Google recusou: ${d.status}${d.error_message ? ` — ${String(d.error_message).slice(0, 200)}` : ''}`,
    };
  } catch (e: any) {
    return { item, ok: false, detail: 'O servidor não conseguiu acessar o Google (sem internet ou saída bloqueada).' };
  }
}
