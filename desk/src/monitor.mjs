// Monitoring. Every server-side error is recorded and grouped, every number is watched for
// disconnects (with WhatsApp's reason in plain words), and system alerts go to Google Chat.
// The Health page, /healthz and the MCP health tools all read from here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { q, one, logEvent } from './db.mjs';
import { getSettings, metaGet, metaSet } from './settings.mjs';
import { connectionState, fetchInstances } from './evo.mjs';
import { postChat } from './reports.mjs';
import { now } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
let commit = process.env.GIT_COMMIT && process.env.GIT_COMMIT !== 'unknown' ? process.env.GIT_COMMIT : '';
if (!commit) {
  try { commit = execFileSync('git', ['-C', path.join(HERE, '..'), 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); } catch {}
}
// Every error carries this, so a bad deploy can be told apart from an old bug.
export const VERSION = `${pkg.version}${commit ? `+${commit}` : ''}`;
export const STARTED_AT = new Date();

// ---------------------------------------------------------------- recording errors
// Keys, tokens, passwords and webhook secrets never reach the errors table or a chat alert.
export function scrub(v) {
  return String(v ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [hidden]')
    .replace(/(apikey|api_key|x-api-key|token|password|passwd|secret)(["'\s:=]+)[^\s"'&,}]{6,}/gi, '$1$2[hidden]')
    .replace(/(chat\.googleapis\.com\/v1\/spaces\/[^\s?"']+)\?[^\s"']+/g, '$1?[hidden]')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/g, '$1[hidden]@');
}
const scrubObj = o => JSON.parse(scrub(JSON.stringify(o ?? {})));
function whereOf(stack) {
  const m = String(stack || '').match(/\/((?:src|tools|public\/js|js)\/[^\s/:)?]+(?:\/[^\s/:)?]+)?\.m?js)(?:\?[^\s:)]*)?:(\d+)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

// Records one error. The same error (same place, same message shape) is counted on one row
// until someone marks it fixed. A new kind of error is reported to Google Chat at once; one
// that keeps happening is reported again at most once an hour.
export async function recordError(source, err, context = {}) {
  try {
    const message = scrub(err?.message || String(err)).slice(0, 1000) || 'unknown error';
    const stack = scrub(err?.stack || '').slice(0, 4000);
    const where = whereOf(err?.stack) || context.where || null;
    const shape = message.replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+/g, '#');
    const fp = crypto.createHash('sha1').update(`${source}|${where}|${shape}`).digest('hex');
    const row = await one(`insert into desk.errors (fingerprint, source, where_, message, stack, context, version)
        values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (fingerprint) where resolved_at is null do update set count = desk.errors.count + 1, last_at = now(),
          message = excluded.message, stack = excluded.stack, context = excluded.context, version = excluded.version
        returning id, count, notified_at, (xmax = 0) as inserted`,
      [fp, source, where, message, stack, JSON.stringify(scrubObj(context)), VERSION]);
    if (row && (row.inserted || !row.notified_at || Date.now() - new Date(row.notified_at).getTime() > 3600000)) {
      await q(`update desk.errors set notified_at = now() where id = $1`, [row.id]);
      await opsAlert(`error:${row.id}:${row.inserted ? 'new' : Math.floor(Date.now() / 3600000)}`,
        `⚠️ Error in ${source}${where ? ` (${where})` : ''}: ${message.slice(0, 300)}${row.count > 1 ? ` — ${row.count} times so far` : ''}. See Health in the dashboard.`, 0);
    }
    return row?.id || null;
  } catch (e) {
    console.error('[monitor] could not record an error:', e.message);
    return null;
  }
}

export async function listErrors({ show = 'open', limit = 100 } = {}) {
  return q(`select id, source, where_, message, count, first_at, last_at, version, resolved_at, resolved_by
    from desk.errors where ($1 = 'all' or resolved_at is null) order by resolved_at nulls first, last_at desc limit $2`,
  [show === 'all' ? 'all' : 'open', Math.min(Math.max(Number(limit) || 100, 1), 500)]);
}
export async function errorDetail(id) {
  return one(`select * from desk.errors where id = $1`, [id]);
}
export async function resolveErrors(ids, who) {
  const r = ids === 'all'
    ? await q(`update desk.errors set resolved_at = now(), resolved_by = $1 where resolved_at is null returning id`, [who || 'someone'])
    : await q(`update desk.errors set resolved_at = now(), resolved_by = $2 where id = any($1) and resolved_at is null returning id`, [ids, who || 'someone']);
  await logEvent('errors.resolve', { count: r.length }, who);
  return { resolved: r.length };
}

// ---------------------------------------------------------------- system alerts
// One key per situation, so the same thing is never announced twice in its cooldown, and at
// most 20 system alerts an hour in total, so a storm never floods the chat space. When the
// database itself is down, the keys are kept in memory and the last known webhook is used, so
// that outage is still reported.
let hourBucket = { hour: -1, n: 0 };
const sentInMemory = new Map();
let lastHook = '';
export async function opsAlert(key, text, cooldownMs = 30 * 60000) {
  const h = Math.floor(Date.now() / 3600000);
  if (hourBucket.hour !== h) hourBucket = { hour: h, n: 0 };
  if (hourBucket.n >= 20) return false;
  let dbUp = true;
  try {
    const prev = await one(`select last_sent_at from desk.ops_alerts where key = $1`, [key]);
    if (prev && (!cooldownMs || Date.now() - new Date(prev.last_sent_at).getTime() < cooldownMs)) return false;
  } catch { dbUp = false; }
  const mem = sentInMemory.get(key);
  if (mem != null && (!cooldownMs || Date.now() - mem < cooldownMs)) return false;
  sentInMemory.set(key, Date.now());
  while (sentInMemory.size > 500) sentInMemory.delete(sentInMemory.keys().next().value);
  hourBucket.n++;
  if (dbUp) {
    await q(`insert into desk.ops_alerts (key, last_sent_at, last_text) values ($1, now(), $2)
      on conflict (key) do update set last_sent_at = now(), sent = desk.ops_alerts.sent + 1, last_text = excluded.last_text`, [key, text.slice(0, 1000)]).catch(() => {});
    await logEvent('ops.alert', { key: key.slice(0, 120), text: text.slice(0, 300) });
  }
  try { const s = await getSettings(); lastHook = s.ops_chat_webhook || s.team_chat_webhook || ''; } catch {}
  if (!lastHook) return false;
  const err = await postChat(lastHook, `*WhatsApp Desk* — ${text}`);
  if (err) console.error('[monitor] alert not delivered:', err);
  return !err;
}

// ---------------------------------------------------------------- WhatsApp disconnects
// Evolution keeps the last disconnect code and payload on its Instance row.
export function reasonText(code, obj) {
  const t = JSON.stringify(obj ?? '').toLowerCase();
  if (t.includes('device_removed')) return 'the device was removed from the phone (WhatsApp → Linked devices)';
  if (t.includes('replaced') || Number(code) === 440) return 'another connection for the same number took over (two sessions at once)';
  if (t.includes('log out instance')) return 'logged out here (a QR expired without a scan, or Log out was pressed)';
  switch (Number(code)) {
    case 401: return 'WhatsApp logged this device out (removed on the phone, or the session expired)';
    case 403: return 'WhatsApp refused the connection — the number may be restricted or banned';
    case 408: return 'the connection timed out (network)';
    case 411: return 'a multi-device mismatch — link the number again';
    case 428: return 'the connection was closed (network, or WhatsApp restarted it)';
    case 500: return 'a WhatsApp server error';
    case 503: return 'WhatsApp is unavailable right now';
    case 515: return 'WhatsApp asked for a restart (normal right after linking)';
    default: return code ? `WhatsApp code ${code}` : 'no reason given';
  }
}
function parseMaybeJson(v) {
  let x = v;
  for (let i = 0; i < 3 && typeof x === 'string'; i++) { try { x = JSON.parse(x); } catch { break; } }
  return x;
}
async function lastDisconnect(instance) {
  const r = await one(`select "disconnectionReasonCode" code, "disconnectionObject" obj, "disconnectionAt" at
    from evolution_api."Instance" where name = $1`, [instance]).catch(() => null);
  if (!r) return null;
  return { code: r.code, at: r.at, reason: reasonText(r.code, parseMaybeJson(r.obj)) };
}

// instance -> { downSince, alerted }
const watch = new Map();
let evolutionDownSince = null, lastResourceCheck = 0;

// Runs every 30 seconds. A number that was linked before and stays off for a minute is
// reported with the reason; when it comes back, that is reported too. Short blips (a
// restart right after linking) are never reported.
export async function monitorTick() {
  const nums = await q(`select instance, label, phone, active from desk.numbers where active`);
  let evoReachable = true;
  const down = [];
  for (const n of nums) {
    const st = await connectionState(n.instance);
    if (st === 'unreachable') { evoReachable = false; break; }
    const w = watch.get(n.instance) || { downSince: null, alerted: false };
    watch.set(n.instance, w);
    if (st === 'open') {
      if (w.alerted) {
        await opsAlert(`up:${n.instance}:${w.downSince}`, `✅ ${n.label}${n.phone ? ` (+${n.phone})` : ''} is connected again.`, 0);
        await logEvent('number.up', { instance: n.instance });
      }
      w.downSince = null; w.alerted = false;
      continue;
    }
    if (!n.phone) continue;                     // never linked yet: waiting for its first scan
    if (!w.downSince) w.downSince = now().getTime();
    down.push(n.instance);
    if (!w.alerted && now().getTime() - w.downSince >= 60000) {
      const d = await lastDisconnect(n.instance);
      w.alerted = true;
      await logEvent('number.down', { instance: n.instance, state: st, code: d?.code ?? null, reason: d?.reason ?? null });
      await opsAlert(`down:${n.instance}:${w.downSince}`,
        `🔴 ${n.label}${n.phone ? ` (+${n.phone})` : ''} is disconnected (${st}). Reason: ${d?.reason || 'unknown'}. Its groups are skipped until it is connected again — open Numbers → Connect / show QR.`, 0);
    }
  }
  // Evolution itself not answering: one alert for everything, repeated at most every 30 min.
  if (!evoReachable) {
    evolutionDownSince ||= now().getTime();
    if (now().getTime() - evolutionDownSince >= 120000) await opsAlert('evolution-down', '🔴 Evolution API is not answering. No number can send or receive until it is back.', 30 * 60000);
  } else if (evolutionDownSince) {
    if (now().getTime() - evolutionDownSince >= 120000) await opsAlert(`evolution-up:${evolutionDownSince}`, '✅ Evolution API is answering again.', 0);
    evolutionDownSince = null;
  }
  // Disk and backups, every 30 minutes.
  if (Date.now() - lastResourceCheck > 30 * 60000) {
    lastResourceCheck = Date.now();
    const disk = diskUsage();
    if (disk && disk.usedPct >= 85) await opsAlert('disk', `🟠 The server disk is ${disk.usedPct}% full (${fmtBytes(disk.freeBytes)} free).`, 6 * 3600000);
    const b = await metaGet('last_backup', null);
    if (b?.at && Date.now() - new Date(b.at).getTime() > 36 * 3600000) {
      await opsAlert('backup', `🟠 The last database backup was ${Math.floor((Date.now() - new Date(b.at).getTime()) / 3600000)} hours ago. Check the backup cron job.`, 12 * 3600000);
    }
  }
  return { checked: nums.length, down: down.length, evolution: evoReachable };
}

// ---------------------------------------------------------------- health
function diskUsage() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { totalBytes: total, freeBytes: free, usedPct: Math.round(((total - free) / total) * 100) };
  } catch { return null; }
}
const fmtBytes = b => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export async function healthReport(workers = []) {
  const numbers = await q(`select instance, label, role, phone, active from desk.numbers order by sort, created_at`);
  const states = await Promise.all(numbers.map(n => connectionState(n.instance)));
  const nums = [];
  for (const [i, n] of numbers.entries()) {
    const st = states[i];
    const w = watch.get(n.instance);
    nums.push({ ...n, state: st, downSince: st === 'open' ? null : (w?.downSince ? new Date(w.downSince).toISOString() : null),
      lastDisconnect: st === 'open' ? null : await lastDisconnect(n.instance) });
  }
  const evolution = await fetchInstances().then(() => true).catch(() => false);
  const openErrors = await listErrors({ show: 'open', limit: 50 });
  const day = await one(`select count(*)::int kinds, coalesce(sum(count), 0)::int total from desk.errors where last_at > now() - interval '24 hours'`);
  const dbSize = await one(`select pg_database_size(current_database())::bigint b`).catch(() => null);
  const mem = process.memoryUsage();
  return {
    version: VERSION, startedAt: STARTED_AT.toISOString(), uptimeSec: Math.round(process.uptime()), node: process.version,
    memory: { rssBytes: mem.rss, heapBytes: mem.heapUsed, systemFreeBytes: os.freemem(), systemTotalBytes: os.totalmem() },
    disk: diskUsage(), databaseBytes: dbSize ? Number(dbSize.b) : null, lastBackup: await metaGet('last_backup', null),
    evolution: { ok: evolution }, numbers: nums, workers,
    errors: { open: openErrors.length, last24h: day, list: openErrors },
  };
}

// ---------------------------------------------------------------- start and stop
// A desk that did not stop cleanly last time crashed or lost power; that is worth a message.
export async function noteStart() {
  const clean = await metaGet('clean_shutdown', true);
  if (clean === false) await opsAlert(`restart:${STARTED_AT.getTime()}`, '♻️ The desk restarted after an unexpected stop (a crash, a kill or a power cut). Nothing is resent on restart.', 0);
  await metaSet('clean_shutdown', false);
  await metaSet('started', { at: STARTED_AT.toISOString(), version: VERSION });
}
export async function noteCleanStop() {
  await metaSet('clean_shutdown', true).catch(() => {});
}
export { fmtBytes };
