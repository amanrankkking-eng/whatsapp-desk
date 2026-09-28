// Login for the dashboard. Required whenever DESK_PASSWORD is set (always, on a server).
import crypto from 'node:crypto';
import { cfg } from './config.mjs';
import { q, one } from './db.mjs';

export const authRequired = () => !!cfg.authPassword;
const SESSION_DAYS = 14;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const attempts = new Map();
export async function login(user, password, ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw Object.assign(new Error('Too many attempts. Wait a minute.'), { status: 429 });
  const ok = safeEqual(user || '', cfg.authUser || 'admin') && safeEqual(password || '', cfg.authPassword);
  if (!ok) {
    a.n += 1; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
    attempts.set(ip, a);
    throw Object.assign(new Error('Wrong username or password'), { status: 401 });
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  await q(`insert into desk.sessions (token, username, expires_at) values ($1, $2, now() + make_interval(days => $3))`, [token, user, SESSION_DAYS]);
  return token;
}

export function cookieFor(token, maxAgeSec) {
  return `desk_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${cfg.cookieSecure ? '; Secure' : ''}`;
}

export async function sessionUser(req) {
  if (!authRequired()) return 'local';
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)desk_session=([a-f0-9]{64})/);
  if (!m) return null;
  const s = await one(`select username from desk.sessions where token = $1 and expires_at > now()`, [m[1]]);
  return s?.username || null;
}

export async function logout(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)desk_session=([a-f0-9]{64})/);
  if (m) await q(`delete from desk.sessions where token = $1`, [m[1]]);
}
