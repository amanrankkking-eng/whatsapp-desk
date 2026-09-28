// Runtime configuration. Everything comes from environment variables so the same code runs
// on a Mac (native install) and on a server (docker compose). On the Mac, missing values are
// read from the local Evolution install at LOCAL_EVOLUTION_DIR.
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return out;
}

const localDir = env.LOCAL_EVOLUTION_DIR || path.join(env.HOME || '', 'Claude/evolution-local');
const localApp = readEnvFile(path.join(localDir, 'app/.env'));
const localPg = readEnvFile(path.join(localDir, '.pgpass.env'));

const databaseUrl = env.DATABASE_URL
  || (localPg.PG_PASSWORD ? `postgresql://evolution:${encodeURIComponent(localPg.PG_PASSWORD)}@127.0.0.1:5433/evolution` : '');

const port = Number(env.PORT) || 8092;

export const cfg = {
  port,
  host: env.HOST || '127.0.0.1',
  databaseUrl,
  evoUrl: (env.EVO_URL || 'http://127.0.0.1:8080').replace(/\/$/, ''),
  evoKey: env.EVO_API_KEY || localApp.AUTHENTICATION_API_KEY || '',
  // Host headers the dashboard answers to. Localhost is always allowed.
  // Entries may be written as a URL ("https://desk.example.com"); only the host part counts.
  allowedHosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`,
    ...(env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '')).filter(Boolean)]),
  // When set, the dashboard asks for this login. Required on a server.
  authUser: env.DESK_USER || '',
  authPassword: env.DESK_PASSWORD || '',
  cookieSecure: env.COOKIE_SECURE === '1',
  tz: 'Asia/Kolkata',
  // Test mode: a movable clock and test-only routes. Never set in production.
  test: env.DESK_TEST === '1',
  // Evolution posts group/message events here when the webhook is enabled per number.
  publicUrl: env.DESK_PUBLIC_URL || `http://127.0.0.1:${port}`,
  workersEnabled: env.DESK_WORKERS !== '0',
};

if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
if (!cfg.evoKey) console.warn('[config] EVO_API_KEY is not set - Evolution calls will fail');
