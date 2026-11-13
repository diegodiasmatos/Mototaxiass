/**
 * Mapbox — integração de servidor.
 *
 * APIs usadas:
 *  - Directions API v5     → rota real por vias (perfil `driving`)
 *  - Geocoding API v6      → busca de endereços e geocodificação reversa
 *  - Tokens API v2         → conferência do token (só no diagnóstico)
 *
 * Tokens:
 *  - MAPBOX_PUBLIC_TOKEN (pk.…) → vai ao navegador para desenhar o mapa
 *    (Mapbox GL JS). É público por natureza; restrinja por URL na conta.
 *  - MAPBOX_SERVER_TOKEN (opcional) → usado só pelo backend. Necessário
 *    apenas quando o token público tem restrição de URL (chamadas de
 *    servidor não enviam referenciador e seriam recusadas). Sem ele, o
 *    backend usa o próprio token público.
 *
 * Só as rotas passam pelo cache persistente (`geo_cache`). Os resultados
 * de geocodificação NÃO são guardados: os termos do Mapbox proíbem
 * armazenar respostas do modo temporário (o gratuito) da Geocoding API.
 */
import crypto from 'node:crypto';
import { db, getCredential, getSetting, getSettingNum } from './db.ts';
import { now } from './util.ts';

function apiBase(): string {
  return (process.env.MAPBOX_API_BASE || 'https://api.mapbox.com').replace(/\/+$/, '');
}

/** Estilos de mapa oferecidos na central (lista fechada: o valor vai ao navegador). */
export const MAP_STYLES: Record<string, string> = {
  'mapbox://styles/mapbox/streets-v12': 'Ruas (padrão)',
  'mapbox://styles/mapbox/navigation-day-v1': 'Navegação (ruas em destaque)',
  'mapbox://styles/mapbox/satellite-streets-v12': 'Satélite com ruas',
};
export const DEFAULT_MAP_STYLE = 'mapbox://styles/mapbox/streets-v12';

export function mapStyle(): string {
  const s = getSetting('mapbox_style');
  return MAP_STYLES[s] ? s : DEFAULT_MAP_STYLE;
}

/** Token do navegador. Só `pk.` é aceito: um token secreto nunca sai do backend. */
export function publicToken(): string | null {
  const t = getCredential('MAPBOX_PUBLIC_TOKEN');
  return t && t.startsWith('pk.') ? t : null;
}
/** Token usado pelo backend: o de servidor, se houver; senão o público. */
export function serverToken(): string | null {
  return getCredential('MAPBOX_SERVER_TOKEN') || publicToken();
}
export function mapboxEnabled(): boolean {
  return !!serverToken() && getSetting('maps_provider') !== 'osm';
}

/**
 * Chamada GET à API do Mapbox. O token vai na query (é assim que a API
 * autentica), por isso as mensagens de erro nunca incluem a URL.
 */
async function mbxGet(path: string, params: Record<string, string>, token: string,
  timeoutMs: number): Promise<any> {
  const url = new URL(apiBase() + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);

  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    let msg = '';
    try { msg = String(((await r.json()) as any)?.message || ''); } catch { /* corpo não-JSON */ }
    const err = new Error(`Mapbox ${r.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`);
    (err as any).status = r.status;
    throw err;
  }
  return r.json();
}

// ---------------------------------------------------------------
// Cache de rotas (a mesma rota não é pedida duas vezes)
// ---------------------------------------------------------------

const ROUTE_CACHE_KIND = 'rota_mapbox';

function cacheKey(kind: string, parts: unknown): string {
  return `${kind}:${crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex')}`;
}

function cacheGet<T>(kind: string, parts: unknown): T | null {
  const key = cacheKey(kind, parts);
  const row = db.prepare('SELECT payload, expires_at FROM geo_cache WHERE key = ?').get(key) as any;
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM geo_cache WHERE key = ?').run(key);
    return null;
  }
  db.prepare('UPDATE geo_cache SET hits = hits + 1 WHERE key = ?').run(key);
  try { return JSON.parse(row.payload) as T; } catch { return null; }
}

function cacheSet(kind: string, parts: unknown, value: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  db.prepare(`INSERT INTO geo_cache (key, kind, payload, created_at, expires_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload,
      expires_at = excluded.expires_at`)
    .run(cacheKey(kind, parts), kind, JSON.stringify(value), now(), now() + ttlMs);
}

/** Estatísticas para a central (quanto o cache está economizando). */
export function cacheStats(): { kind: string; entradas: number; acertos: number }[] {
  return db.prepare(`SELECT kind, COUNT(*) entradas, COALESCE(SUM(hits),0) acertos
    FROM geo_cache GROUP BY kind`).all() as any[];
}

export function purgeExpiredCache(): void {
  db.prepare('DELETE FROM geo_cache WHERE expires_at < ?').run(now());
}

// ---------------------------------------------------------------
// Rotas (Directions API)
// ---------------------------------------------------------------

export interface MapboxRoute {
  distance_m: number;
  duration_s: number;
  geometry: number[][];          // [[lng,lat],...]
}

interface LatLng { lat: number; lng: number }

async function fetchRoute(from: LatLng, to: LatLng, token: string): Promise<MapboxRoute | null> {
  // O Mapbox não tem perfil de motocicleta; `driving` segue as mesmas vias
  // e mãos de direção, e a interface informa que é rota de carro.
  const data = await mbxGet(
    `/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}`,
    { alternatives: 'false', geometries: 'geojson', overview: 'full', steps: 'false' },
    token, 8000);
  const rt = data?.code === 'Ok' ? data.routes?.[0] : null;
  if (!rt || !Number.isFinite(rt.distance) || !Number.isFinite(rt.duration)) return null;
  const coords = rt.geometry?.coordinates;
  return {
    distance_m: Math.round(rt.distance),
    duration_s: Math.round(rt.duration),
    geometry: Array.isArray(coords) ? coords : [],
  };
}

/** Rota por vias entre dois pontos, com cache. Nulo quando não há rota. */
export async function mapboxRoute(from: LatLng, to: LatLng): Promise<MapboxRoute | null> {
  const token = serverToken();
  if (!token) return null;

  const parts = [from.lat.toFixed(5), from.lng.toFixed(5), to.lat.toFixed(5), to.lng.toFixed(5)];
  const cached = cacheGet<MapboxRoute>(ROUTE_CACHE_KIND, parts);
  if (cached) return cached;

  const result = await fetchRoute(from, to, token);
  if (!result) return null;
  cacheSet(ROUTE_CACHE_KIND, parts, result, getSettingNum('cache_route_hours') * 3600_000);
  return result;
}

// ---------------------------------------------------------------
// Geocoding API v6 — busca e reversa (sem cache; ver cabeçalho)
// ---------------------------------------------------------------

export interface MapboxPlace {
  /** linha pronta para exibir: "Avenida Tupãssi 450, Centro, Assis Chateaubriand" */
  text: string;
  lat: number;
  lng: number;
  /** address | street | neighborhood | locality | place … */
  kind: string;
  /** true quando o ponto é um endereço com número ou uma rua (não só o bairro) */
  exact: boolean;
}

function featureToPlace(f: any): MapboxPlace | null {
  const p = f?.properties ?? {};
  const lat = Number(p.coordinates?.latitude ?? f?.geometry?.coordinates?.[1]);
  const lng = Number(p.coordinates?.longitude ?? f?.geometry?.coordinates?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const kind = String(p.feature_type || '');
  const name = String(p.name_preferred || p.name || '').trim();
  const ctx = p.context ?? {};
  const pieces = [name];
  // bairro e cidade só acrescentam quando o item é mais específico que eles
  if (kind === 'address' || kind === 'street') pieces.push(ctx.neighborhood?.name, ctx.place?.name);
  else if (kind === 'neighborhood' || kind === 'locality') pieces.push(ctx.place?.name);
  const seen = new Set<string>();
  const text = pieces
    .map(x => String(x || '').trim())
    .filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
    .join(', ');
  if (!text) return null;
  return { text, lat, lng, kind, exact: kind === 'address' || kind === 'street' };
}

/**
 * Busca de endereços limitada à área atendida: a caixa (`bbox`) impede que
 * a rua de mesmo nome do município vizinho apareça, e `proximity` puxa
 * para o centro da cidade.
 */
export async function mapboxSearch(input: string): Promise<MapboxPlace[] | null> {
  const token = serverToken();
  if (!token) return null;

  // a API recusa ';' (separador de lote) e consultas acima de 256 caracteres
  const q = input.replace(/;/g, ' ').trim().slice(0, 200);
  if (!q) return [];

  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
  const km = Math.min(50, getSettingNum('coverage_radius_km'));
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.cos(cLat * Math.PI / 180));

  const data = await mbxGet('/search/geocode/v6/forward', {
    q,
    country: 'br',
    language: 'pt',
    proximity: `${cLng},${cLat}`,
    bbox: [cLng - dLng, cLat - dLat, cLng + dLng, cLat + dLat].map(n => n.toFixed(5)).join(','),
    types: 'address,street,neighborhood,locality',
    autocomplete: 'true',
    limit: '8',
  }, token, 6000);

  return (data?.features ?? [])
    .map(featureToPlace)
    .filter((x: MapboxPlace | null): x is MapboxPlace => !!x);
}

/** Endereço de uma coordenada (GPS ou toque no mapa). Nulo quando não há nada perto. */
export async function mapboxReverse(lat: number, lng: number):
  Promise<{ text: string; exact: boolean } | null> {
  const token = serverToken();
  if (!token) return null;

  const data = await mbxGet('/search/geocode/v6/reverse', {
    longitude: String(lng), latitude: String(lat), language: 'pt', country: 'br',
  }, token, 6000);

  // sem `types`, a resposta traz um item por nível (endereço, rua, bairro,
  // cidade…): fica o mais específico disponível
  const places: MapboxPlace[] = (data?.features ?? [])
    .map(featureToPlace)
    .filter((x: MapboxPlace | null): x is MapboxPlace => !!x);
  const best = ['address', 'street', 'neighborhood', 'locality', 'place']
    .map(k => places.find(p => p.kind === k))
    .find(Boolean);
  return best ? { text: best.text, exact: best.exact } : null;
}

// ---------------------------------------------------------------
// Diagnóstico da central (diz exatamente o que funciona e o que falha)
// ---------------------------------------------------------------

type Check = { item: string; ok: boolean; detail: string };

function explain(e: any, usingPublicToken: boolean): string {
  if (e?.status === 401) return 'Token recusado pelo Mapbox (inválido, expirado ou revogado).';
  if (e?.status === 403) {
    return usingPublicToken
      ? 'Recusado (403). O token público tem restrição de URL e o servidor não envia ' +
        'referenciador: crie um segundo token SEM restrição de URL e salve em "Token de servidor".'
      : 'Recusado (403): o token de servidor não tem permissão para esta API.';
  }
  if (e?.status === 429) return 'Limite de requisições do Mapbox atingido. Tente em instantes.';
  if (e?.name === 'TimeoutError') return 'O Mapbox não respondeu a tempo.';
  if (e?.status === undefined && e instanceof TypeError) {
    return 'O servidor não conseguiu acessar api.mapbox.com (sem internet ou saída bloqueada).';
  }
  return `Falhou: ${e?.message || e}`;
}

export async function testMapboxToken(): Promise<Check[]> {
  const checks: Check[] = [];
  const pub = publicToken();
  const srv = serverToken();

  if (!pub && !srv) {
    checks.push({
      item: 'Token do Mapbox', ok: false,
      detail: 'Não configurado — o sistema usa OpenStreetMap/OSRM (gratuito).',
    });
    return checks;
  }

  // 1) token do navegador: é ele que desenha o mapa nos aplicativos
  if (!pub) {
    checks.push({
      item: 'Token público (mapa nos aplicativos)', ok: false,
      detail: 'Sem ele o mapa visual continua em OpenStreetMap (funcional e gratuito).',
    });
  } else {
    try {
      const t = await mbxGet('/tokens/v2', {}, pub, 6000);
      const valid = t?.code === 'TokenValid';
      checks.push({
        item: 'Token público (mapa nos aplicativos)', ok: valid,
        detail: valid
          ? `Válido${t?.token?.user ? ` — conta "${t.token.user}"` : ''}. ` +
            'Restrinja por URL (seu domínio) em account.mapbox.com.'
          : `O Mapbox respondeu: ${t?.code || 'token inválido'}.`,
      });
    } catch (e: any) {
      checks.push({
        item: 'Token público (mapa nos aplicativos)', ok: false, detail: explain(e, true),
      });
    }
  }

  const usingPublic = srv === pub;
  const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');

  // 2) rota de teste dentro da cidade atendida (sem cache: o teste é de verdade)
  try {
    const rt = await fetchRoute({ lat: cLat, lng: cLng },
      { lat: cLat + 0.02, lng: cLng + 0.01 }, srv!);
    checks.push({
      item: 'Rotas (Directions API)', ok: !!rt,
      detail: rt
        ? `Rota de teste: ${(rt.distance_m / 1000).toFixed(1)} km, ${Math.round(rt.duration_s / 60)} min.`
        : 'A API respondeu, mas sem rota para o trajeto de teste.',
    });
  } catch (e: any) {
    checks.push({ item: 'Rotas (Directions API)', ok: false, detail: explain(e, usingPublic) });
  }

  // 3) busca de endereços ("rua" completa para qualquer rua da área atendida)
  try {
    const found = await mapboxSearch('rua');
    checks.push({
      item: 'Busca de endereços (Geocoding API)', ok: !!found?.length,
      detail: found?.length
        ? `${found.length} resultado(s) para "rua" na área atendida — o primeiro: ${found[0].text}.`
        : 'A API respondeu, mas não achou nenhuma rua na área atendida. Confira o centro e o ' +
          'raio de cobertura em Configurações.',
    });
  } catch (e: any) {
    checks.push({
      item: 'Busca de endereços (Geocoding API)', ok: false, detail: explain(e, usingPublic),
    });
  }

  // 4) endereço a partir de coordenada (GPS / toque no mapa)
  try {
    const rev = await mapboxReverse(cLat, cLng);
    checks.push({
      item: 'Endereço do GPS (geocodificação reversa)', ok: !!rev,
      detail: rev ? `Centro da cidade: ${rev.text}` : 'Sem resultado para o centro configurado.',
    });
  } catch (e: any) {
    checks.push({
      item: 'Endereço do GPS (geocodificação reversa)', ok: false, detail: explain(e, usingPublic),
    });
  }

  const stats = cacheStats();
  checks.push({
    item: 'Cache de rotas', ok: true,
    detail: `${stats.reduce((s, x) => s + x.entradas, 0)} entrada(s), ` +
      `${stats.reduce((s, x) => s + x.acertos, 0)} chamada(s) evitada(s).`,
  });

  return checks;
}
