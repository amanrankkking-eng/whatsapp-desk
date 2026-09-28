// Evolution API client. One Evolution server holds every number; each number is an instance.
import { cfg } from './config.mjs';

export async function evo(method, route, body, timeoutMs = 60000) {
  const res = await fetch(cfg.evoUrl + route, {
    method,
    headers: { apikey: cfg.evoKey, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data?.response?.message ?? data).slice(0, 300);
    const e = new Error(`Evolution ${res.status}: ${msg}`);
    e.evoStatus = res.status;
    throw e;
  }
  return data;
}

export async function connectionState(instance) {
  try {
    const d = await evo('GET', `/instance/connectionState/${encodeURIComponent(instance)}`, null, 15000);
    return d?.instance?.state || 'unknown';
  } catch (e) {
    return e.evoStatus === 404 ? 'missing' : 'unreachable';
  }
}

export async function fetchInstances() {
  const d = await evo('GET', '/instance/fetchInstances', null, 20000);
  return (Array.isArray(d) ? d : [d]).map(x => x?.instance || x).filter(Boolean);
}

export const encodeInstance = s => encodeURIComponent(s);
