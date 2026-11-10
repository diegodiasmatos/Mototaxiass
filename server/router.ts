import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SessionUser {
  id: string;
  role: 'passenger' | 'driver' | 'admin';
  name: string;
  email: string;
  phone: string | null;
  cpf: string | null;
  photo: string | null;
  blocked: number;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  user: SessionUser | null;
  ip: string;
}

export type Handler = (ctx: Ctx) => void | Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  /** null = público; 'any' = qualquer usuário logado; senão papel exigido */
  auth: null | 'any' | 'passenger' | 'driver' | 'admin';
  handler: Handler;
}

export function route(def: string, auth: Route['auth'], handler: Handler): Route {
  const [method, path] = def.split(' ');
  const paramNames: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:[a-zA-Z_]+/g, seg => {
    paramNames.push(seg.slice(1));
    return '([^/]+)';
  }) + '$');
  return { method, pattern, paramNames, auth, handler };
}

export function matchRoute(routes: Route[], method: string, pathname: string):
  { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}
