/**
 * Localização e mapas: destinos recentes do próprio passageiro, contagem de
 * carregamentos do mapa do Google e o painel de consumo da central.
 */
import { db, audit, setSetting } from './db.ts';
import { ApiError, json, now, readBody, rateLimit } from './util.ts';
import { route, type Route } from './router.ts';
import { countGoogle, usageReport, GOOGLE_APIS } from './geo-usage.ts';

const RECENT_DAYS = 90;

export const locationRoutes: Route[] = [

  /**
   * Destinos recentes: só das corridas DESTA pessoa, dos últimos 90 dias, sem
   * repetir. Nada novo é guardado: vem do histórico de corridas que já existe
   * (e some junto com ele, pela política de retenção).
   */
  route('GET /api/geo/recent', 'passenger', ({ res, user }) => {
    const rows = db.prepare(`SELECT dest_text text, dest_lat lat, dest_lng lng, MAX(requested_at) at
      FROM rides WHERE passenger_id = ? AND requested_at > ? AND status IN ('completed','awaiting_confirmation','in_progress','accepted','requested','cancelled')
      GROUP BY dest_text ORDER BY at DESC LIMIT 5`).all(user!.id, now() - RECENT_DAYS * 86400_000) as any[];
    json(res, 200, { recent: rows.map(r => ({ text: r.text, lat: r.lat, lng: r.lng })) });
  }),

  /** O navegador avisa que desenhou um mapa do Google (é isso que o Google cobra). */
  route('POST /api/geo/mapload', 'any', ({ res, user }) => {
    // contar a mais nunca gera custo (no máximo troca o mapa pelo OSM); o limite evita inflar à toa
    if (rateLimit(`mapload:${user!.id}`, 30, 3600_000)) countGoogle('maploads');
    json(res, 200, { ok: true });
  }),

  route('GET /api/admin/geo-usage', 'admin', ({ res }) => {
    json(res, 200, usageReport());
  }),

  route('PUT /api/admin/geo-usage', 'admin', async ({ req, res, user }) => {
    const b = await readBody(req);
    const changed: string[] = [];
    for (const a of GOOGLE_APIS) {
      if (b[a.api] === undefined) continue;
      const v = Math.floor(Number(b[a.api]));
      if (!Number.isFinite(v) || v < 0) throw new ApiError(400, `Teto inválido para ${a.label}.`);
      if (v > a.free) throw new ApiError(400, `${a.label}: o teto não pode passar da cota grátis do Google (${a.free}/mês).`);
      setSetting(a.setting, String(v));
      changed.push(`${a.label}=${v}`);
    }
    if (changed.length) audit(user!.id, 'google_caps', 'settings', undefined, changed.join(', '));
    json(res, 200, usageReport());
  }),
];
