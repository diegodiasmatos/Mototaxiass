import { haversineM, ApiError } from './util.ts';
import { getSetting, getSettingNum } from './db.ts';

const UA = 'AssisMotoTaxi/1.0 (plataforma de mototaxi; contato: admin local)';

export interface RouteResult {
  distance_m: number;
  duration_s: number;
  /** GeoJSON LineString coordinates [[lng,lat],...] */
  geometry: number[][];
  /** true quando calculado por estimativa (sem serviço de rotas) */
  estimated: boolean;
}

export interface GeoPoint { lat: number; lng: number; text?: string }

function offline(): boolean { return process.env.GEO_OFFLINE === '1'; }

/**
 * Rota real por vias usando OSRM (perfil driving — adequado para motos em área
 * urbana). Fallback: haversine × 1.3 (fator de malha viária urbana) quando o
 * serviço estiver indisponível, marcado como `estimated`.
 */
export async function route(from: GeoPoint, to: GeoPoint): Promise<RouteResult> {
  if (!offline()) {
    try {
      const base = process.env.OSRM_BASE || 'https://router.project-osrm.org';
      const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
        `?overview=full&geometries=geojson&alternatives=false`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const data: any = await r.json();
        const rt = data?.routes?.[0];
        if (rt && Number.isFinite(rt.distance)) {
          return {
            distance_m: Math.round(rt.distance),
            duration_s: Math.round(rt.duration),
            geometry: rt.geometry?.coordinates ?? [],
            estimated: false,
          };
        }
      }
    } catch { /* cai no fallback */ }
  }
  const straight = haversineM(from.lat, from.lng, to.lat, to.lng);
  const dist = Math.round(straight * 1.3);
  return {
    distance_m: dist,
    duration_s: Math.round(dist / (25000 / 3600)), // ~25 km/h urbano
    geometry: [[from.lng, from.lat], [to.lng, to.lat]],
    estimated: true,
  };
}

/** Pontos de referência locais — fallback quando o geocodificador está fora. */
const LOCAL_PLACES: { name: string; lat: number; lng: number }[] = [
  { name: 'Centro - Assis Chateaubriand', lat: -24.4156, lng: -53.5216 },
  { name: 'Rodoviária de Assis Chateaubriand (aprox.)', lat: -24.4190, lng: -53.5180 },
  { name: 'Hospital Municipal (aprox.)', lat: -24.4120, lng: -53.5250 },
  { name: 'Lago Municipal (aprox.)', lat: -24.4080, lng: -53.5160 },
  { name: 'Av. Tupãssi (aprox.)', lat: -24.4210, lng: -53.5280 },
  { name: 'Bairro Jardim Paraná (aprox.)', lat: -24.4230, lng: -53.5150 },
];

export interface GeoSearchResult { text: string; lat: number; lng: number; approx?: boolean }

/** Busca de endereços via Nominatim, limitada à região da cidade. */
export async function searchAddress(q: string): Promise<GeoSearchResult[]> {
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const city = getSetting('city_name');
  if (!offline()) {
    try {
      const base = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
      const d = 0.25; // ~25 km de viewbox
      const url = `${base}/search?format=jsonv2&limit=6&countrycodes=br&bounded=1` +
        `&viewbox=${cLng - d},${cLat - d},${cLng + d},${cLat + d}` +
        `&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const data: any[] = await r.json() as any[];
        if (Array.isArray(data) && data.length) {
          return data.map(p => ({
            text: String(p.display_name).split(',').slice(0, 4).join(','),
            lat: Number(p.lat), lng: Number(p.lon),
          }));
        }
      }
    } catch { /* cai no fallback */ }
  }
  const qn = q.toLowerCase();
  return LOCAL_PLACES
    .filter(p => p.name.toLowerCase().includes(qn) || qn.length < 3)
    .map(p => ({ text: `${p.name}, ${city}`, lat: p.lat, lng: p.lng, approx: true }));
}

/** Reverse geocoding com fallback honesto para coordenadas. */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  if (!offline()) {
    try {
      const base = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
      const url = `${base}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const data: any = await r.json();
        if (data?.display_name) return String(data.display_name).split(',').slice(0, 4).join(',');
      }
    } catch { /* fallback */ }
  }
  return `Localização (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

/** Valida que o ponto está dentro da área de cobertura configurada. */
export function assertInCoverage(p: GeoPoint, label: string): void {
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const radius = getSettingNum('coverage_radius_km') * 1000;
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) ||
      Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    throw new ApiError(400, `Coordenadas inválidas em ${label}.`);
  }
  const d = haversineM(p.lat, p.lng, cLat, cLng);
  if (d > radius) {
    throw new ApiError(422,
      `O ponto de ${label} está fora da área de cobertura (${getSetting('city_name')}).`);
  }
}
