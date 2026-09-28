// WhatsApp Desk: one dashboard for every WhatsApp number on one Evolution API server, with the
// reseller flow ("Every Step, Start to End") built in. Plain Node, no framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cfg } from './config.mjs';
import { q, one, migrate, logEvent, pool } from './db.mjs';
import { getSettings, saveSettings } from './settings.mjs';
import { connectionState } from './evo.mjs';
import * as numbers from './numbers.mjs';
import * as chats from './chats.mjs';
import * as ladder from './ladder.mjs';
import * as resellers from './resellers.mjs';
import { bindGroups, listBindIssues, ignoreIssue } from './bind.mjs';
import { readGroups, assignTracks, detectReplies } from './read.mjs';
import { planDay, approveDay, todaysBatches, nextTurn, CHECK_NAMES } from './plan.mjs';
import { workerTick, stopRun, closeRestDay } from './runner.mjs';
import { notifyAlerts, ackAlert, buildReports, postChat } from './reports.mjs';
import { authRequired, login, logout, cookieFor, sessionUser } from './auth.mjs';
import { istDate, istToUtc, addIstDays, now, setClock, advanceClock, httpError, clampInt, TEXT_SQL, typeLabel } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------- routing
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
}

// ---------------------------------------------------------------- workers
const workers = [];
const workerState = {};
function every(ms, name, fn, { firstAfter = 3000 } = {}) {
  workers.push({ ms, name, fn, firstAfter });
}
async function runWorker(name, fn) {
  const st = (workerState[name] ||= { running: false, lastOk: null, lastError: null, runs: 0 });
  if (st.running) return;
  st.running = true;
  try { st.lastResult = await fn(); st.lastOk = now().toISOString(); st.lastError = null; }
  catch (e) { st.lastError = String(e.message || e).slice(0, 300); console.error(`[worker ${name}]`, e.message); }
  finally { st.running = false; st.runs++; }
}

// Stage 2, 3, 4 and 11 every few minutes: new groups, binding, the read, statuses and replies.
async function readCycle() {
  await numbers.syncNumbers();
  const open = [];
  for (const n of await q(`select instance from desk.numbers where active`)) {
    const st = await connectionState(n.instance);
    numbers.noteState(n.instance, st);
    await q(`update desk.numbers set state = $2, state_at = now() where instance = $1 and state is distinct from $2`, [n.instance, st]);
    if (st === 'open') open.push(n.instance);
  }
  for (const inst of open) {
    const synced = await one(`select value from desk.meta where key = $1`, [`groups_synced:${inst}`]);
    const age = synced ? now() - new Date(synced.value) : Infinity;
    if (age > 10 * 60000) await numbers.refreshGroups(inst).catch(e => console.error('[groups]', inst, e.message));
    else for (const jid of (await numbers.newGroupJids(inst)).slice(0, 20)) await numbers.refreshOneGroup(inst, jid).catch(() => {});
  }
  await numbers.learnLidsFromMessages();
  await numbers.rebuildPeople();
  const b = await bindGroups();
  const r = await readGroups();
  const t = await assignTracks();
  const y = await detectReplies();
  return { open: open.length, ...b, ...r, ...t, ...y };
}

// ---------------------------------------------------------------- helpers
const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const inst = v => { const s = decodeURIComponent(v); if (!INSTANCE_RE.test(s)) throw httpError(400, 'bad number id'); return s; };
const jidOf = v => decodeURIComponent(v);
const intOf = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'bad id'); return n; };
const csvCell = v => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows, cols) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n');

let stateCache = { at: 0, map: {} };
async function liveStates() {
  if (Date.now() - stateCache.at < 4000) return stateCache.map;
  const list = await q(`select instance from desk.numbers`);
  const map = {};
  await Promise.all(list.map(async n => { map[n.instance] = await connectionState(n.instance); numbers.noteState(n.instance, map[n.instance]); }));
  stateCache = { at: Date.now(), map };
  return map;
}

// ---------------------------------------------------------------- API: session
route('POST', '/api/login', async ({ body, req, res }) => {
  if (!authRequired()) return { ok: true, user: 'local' };
  const token = await login(String(body.user || ''), String(body.password || ''), req.socket.remoteAddress);
  res.setHeader('set-cookie', cookieFor(token, 14 * 86400));
  return { ok: true, user: body.user };
}, { public: true });
route('POST', '/api/logout', async ({ req, res }) => {
  await logout(req);
  res.setHeader('set-cookie', cookieFor('', 0));
  return { ok: true };
}, { public: true });
route('GET', '/api/me', async ({ user }) => ({ user, authRequired: authRequired(), test: cfg.test, version: VERSION }), { public: true });

// ---------------------------------------------------------------- API: overview
route('GET', '/api/overview', async () => {
  const today = istDate();
  const since = istToUtc(today, '00:00');
  const [stages] = [await q(`select stage, count(*)::int n from desk.resellers group by stage`)];
  const sentToday = await one(`select count(*)::int n from desk.send_log where sent_at >= $1`, [since]);
  const repliesToday = await one(`select count(*)::int n, count(distinct jid)::int groups from desk.replies where ts >= $1`, [since]);
  const openAlerts = await one(`select count(*)::int n from desk.alerts where acked_at is null`);
  const issues = await one(`select count(*)::int n from desk.bind_issues where not ignored`);
  const needs = await one(`select count(*)::int n from desk.resellers where group_jid is not null and track is null and stage = 'live' and not paused and not hold and not dnc`);
  const run = await one(`select id, status, day, created_at, finished_at, stop_reason,
      (select count(*)::int from desk.sends s where s.run_id = r.id and s.status = 'sent') sent,
      (select count(*)::int from desk.sends s where s.run_id = r.id) total
    from desk.runs r order by id desc limit 1`);
  const states = await liveStates();
  const nums = (await numbers.listNumbers()).map(n => ({ ...n, state: states[n.instance] || n.state }));
  return { today, stages, sentToday: sentToday.n, repliesToday, openAlerts: openAlerts.n, bindIssues: issues.n, needsStatus: needs.n,
    lastRun: run, numbers: nums, batches: await todaysBatches(), workers: workerState };
});

// ---------------------------------------------------------------- API: numbers
route('GET', '/api/numbers', async () => {
  const states = await liveStates();
  return (await numbers.listNumbers()).map(n => ({ ...n, state: states[n.instance] || n.state }));
});
route('POST', '/api/numbers', async ({ body, user }) => {
  const r = await numbers.addNumber(body);
  stateCache.at = 0;
  await logEvent('number.add.ui', { instance: r.instance }, user);
  return r;
});
route('POST', '/api/numbers/sync', async () => { stateCache.at = 0; return numbers.syncNumbers(); });
route('GET', '/api/numbers/:inst/link', async ({ params, query }) => numbers.linkInfo(inst(params.inst), query.get('phone') || null, { start: query.get('start') === '1' }));
route('PATCH', '/api/numbers/:inst', async ({ params, body }) => numbers.updateNumber(inst(params.inst), body));
route('POST', '/api/numbers/:inst/logout', async ({ params }) => { stateCache.at = 0; return numbers.logoutNumber(inst(params.inst)); });
route('DELETE', '/api/numbers/:inst', async ({ params }) => { stateCache.at = 0; return numbers.removeNumber(inst(params.inst)); });
route('POST', '/api/numbers/:inst/refresh-groups', async ({ params }) => {
  const r = await numbers.refreshGroups(inst(params.inst));
  await numbers.rebuildPeople();
  return r;
});
route('POST', '/api/numbers/move-slice', async ({ body, user }) => resellers.moveSlice(inst(body.from), inst(body.to), user));
route('GET', '/api/groups', async ({ query }) => {
  const i = query.get('instance');
  return q(`select g.instance, g.jid, g.subject, g.size, g.announce, g.left_group, g.synced_at, n.label number_label, n.role,
      r.id reseller_id, r.code reseller_code, r.name reseller_name
    from desk.groups g join desk.numbers n on n.instance = g.instance left join desk.resellers r on r.group_jid = g.jid
    where ($1::text is null or g.instance = $1) and not g.is_community
    order by g.left_group, lower(coalesce(g.subject, g.jid))`, [i && i !== 'all' ? i : null]);
});

// ---------------------------------------------------------------- API: chats
route('GET', '/api/chats', async ({ query }) => chats.listChats(query.get('instance')));
route('GET', '/api/chats/:inst/:jid', async ({ params, query }) => chats.chatMessages(inst(params.inst), jidOf(params.jid), query.get('limit')));
route('POST', '/api/chats/:inst/:jid/seen', async ({ params, body }) => chats.markSeen(jidOf(params.jid), body.ts));
route('POST', '/api/chats/:inst/:jid/send', async ({ params, body, user }) => {
  const r = await chats.sendText(inst(params.inst), jidOf(params.jid), body.text, body.quotedId);
  await logEvent('chat.send', { instance: params.inst, jid: jidOf(params.jid) }, user);
  return r;
}, { limit: 1 << 20 });
route('POST', '/api/chats/:inst/:jid/send-media', async ({ params, body, user }) => {
  const r = await chats.sendMedia(inst(params.inst), jidOf(params.jid), body);
  await logEvent('chat.send-media', { instance: params.inst, jid: jidOf(params.jid), type: body.mediatype }, user);
  return r;
}, { limit: 25 << 20 });
route('GET', '/api/media/:inst/:id', async ({ params, res }) => {
  const id = decodeURIComponent(params.id);
  if (!/^[A-Za-z0-9]{6,64}$/.test(id)) throw httpError(400, 'bad media id');
  const m = await chats.mediaOf(inst(params.inst), id);
  const safe = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp|webm)|audio\/[a-z0-9.+-]+|application\/pdf)(;.*)?$/i.test(m.mimetype);
  res.writeHead(200, {
    'content-type': safe ? m.mimetype.split(';')[0] : 'application/octet-stream',
    'content-disposition': `${safe ? 'inline' : 'attachment'}; filename="${String(m.fileName || `${id}`).replace(/[^\w.\- ]/g, '_')}"`,
    'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(Buffer.from(m.base64, 'base64'));
  return undefined;
});

// ---------------------------------------------------------------- API: resellers
route('GET', '/api/lists', async () => ({ callOutcomes: resellers.CALL_OUTCOMES, stages: resellers.STAGES, checks: CHECK_NAMES }));
route('GET', '/api/resellers', async () => {
  const [rows, s, batches] = [await resellers.listResellers(), await getSettings(), await todaysBatches()];
  for (const r of rows) {
    const inLoop = r.stage === 'live' && r.group_jid && !r.paused && !r.hold && !r.dnc && r.track;
    r.next_due = inLoop ? nextTurn(r.track === 'offer' ? r.of_batch : r.fu_batch, batches[r.track], batches.ringLen, batches[`${r.track}_ran_today`], s) : null;
  }
  return rows;
});
route('POST', '/api/resellers', async ({ body }) => resellers.addReseller(body));
route('POST', '/api/resellers/import', async ({ body }) => resellers.importLeads({ csv: body.csv, source: body.source, owner_id: body.owner_id }), { limit: 5 << 20 });
route('GET', '/api/resellers/:id', async ({ params }) => resellers.resellerDetail(intOf(params.id)));
route('PATCH', '/api/resellers/:id', async ({ params, body, user }) => resellers.updateReseller(intOf(params.id), body, user));
route('POST', '/api/resellers/:id/call', async ({ params, body, user }) => resellers.logCall(intOf(params.id), body, user));
route('POST', '/api/resellers/:id/track', async ({ params, body, user }) => resellers.setTrack(intOf(params.id), body.track || null, user));
route('POST', '/api/resellers/:id/action', async ({ params, body, user }) => resellers.applyAction(intOf(params.id), String(body.action), user));
route('POST', '/api/resellers/:id/bind', async ({ params, body, user }) => resellers.bindByHand(intOf(params.id), { instance: inst(body.instance), jid: String(body.jid) }, user));
route('POST', '/api/resellers/:id/unbind', async ({ params, user }) => resellers.unbind(intOf(params.id), user));
route('GET', '/api/lead-rejects', async () => q(`select * from desk.lead_rejects order by id desc limit 300`));

route('GET', '/api/owners', async () => resellers.listOwners());
route('POST', '/api/owners', async ({ body }) => resellers.saveOwner(body));
route('DELETE', '/api/owners/:id', async ({ params }) => resellers.deleteOwner(intOf(params.id)));

route('GET', '/api/bind-issues', async () => listBindIssues());
route('POST', '/api/bind-issues/ignore', async ({ body }) => ignoreIssue(String(body.jid), body.ignored));

// ---------------------------------------------------------------- API: today, runs
route('GET', '/api/today', async () => {
  const plan = await planDay();
  const run = await one(`select * from desk.runs where status = 'running' order by id desc limit 1`);
  const todayRuns = await q(`select id, status, created_at, finished_at, stop_reason, approved_by from desk.runs where day = $1 order by id desc`, [istDate()]);
  return { plan, running: run ? { id: run.id } : null, todayRuns };
});
route('POST', '/api/today/approve', async ({ body, user }) => approveDay(body.ids, user));
route('GET', '/api/runs', async () => q(`select r.id, r.day, r.status, r.approved_by, r.created_at, r.finished_at, r.stop_reason, r.fu_batch, r.of_batch,
    (select count(*)::int from desk.sends s where s.run_id = r.id) total,
    (select count(*)::int from desk.sends s where s.run_id = r.id and s.status = 'sent') sent,
    (select count(*)::int from desk.skips k where k.run_id = r.id) skipped
  from desk.runs r order by r.id desc limit 100`));
route('GET', '/api/runs/:id', async ({ params }) => {
  const id = intOf(params.id);
  const run = await one(`select * from desk.runs where id = $1`, [id]);
  if (!run) throw httpError(404, 'Unknown run');
  const sends = await q(`select s.*, r.code, r.name, n.label sender_label,
      (select subject from desk.groups g where g.jid = s.jid and subject is not null limit 1) group_name
    from desk.sends s left join desk.resellers r on r.id = s.reseller_id left join desk.numbers n on n.instance = s.instance
    where s.run_id = $1 order by s.scheduled_at`, [id]);
  const skips = await q(`select k.*, r.code, r.name from desk.skips k left join desk.resellers r on r.id = k.reseller_id where k.run_id = $1 order by k.id`, [id]);
  return { run, sends, skips };
});
route('POST', '/api/runs/:id/stop', async ({ params, user }) => stopRun(intOf(params.id), `stopped by ${user || 'a person'}`, user));

// ---------------------------------------------------------------- API: replies and alerts
route('GET', '/api/alerts', async ({ query }) => q(`select a.*, r.code, r.name, o.name owner_name,
    (select subject from desk.groups g where g.jid = a.jid and subject is not null limit 1) group_name
  from desk.alerts a join desk.resellers r on r.id = a.reseller_id left join desk.owners o on o.id = a.owner_id
  where ($1 = 'all' or a.acked_at is null) order by a.acked_at nulls first, a.last_at desc limit 300`, [query.get('show') === 'all' ? 'all' : 'open']));
route('POST', '/api/alerts/:id/ack', async ({ params, user }) => ackAlert(intOf(params.id), user));
// Replies on a day, for every group of every number (not only reseller groups).
route('GET', '/api/replies', async ({ query }) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(query.get('day') || '') ? query.get('day') : istDate();
  const from = istToUtc(day, '00:00').getTime() / 1000, to = istToUtc(addIstDays(day, 1), '00:00').getTime() / 1000;
  // Several of our numbers can sit in one group and each stores the same message: count ids once.
  const rows = await q(`select m.jid, count(distinct m.id) filter (where not m.ours)::int replies, count(distinct m.id) filter (where m.ours)::int ours,
      max(m.ts) filter (where not m.ours) last_ts, array_agg(distinct m.instance) instances
    from desk.msgx m where m.ts >= $1 and m.ts < $2 and m.jid like '%@g.us' group by m.jid order by replies desc`, [from, to]);
  const jids = rows.map(r => r.jid);
  const names = await q(`select distinct on (jid) jid, subject from desk.groups where jid = any($1) and subject is not null`, [jids]);
  const rs = await q(`select id, code, name, group_jid from desk.resellers where group_jid = any($1)`, [jids]);
  const last = await q(`select distinct on (jid) jid, ${TEXT_SQL} txt, type, sender_name from desk.msgx
    where jid = any($1) and not ours and ts >= $2 and ts < $3 order by jid, ts desc`, [jids, from, to]);
  return { day, groups: rows.map(r => ({ ...r, last_ts: Number(r.last_ts) || null, name: names.find(n => n.jid === r.jid)?.subject || r.jid,
    reseller: rs.find(x => x.group_jid === r.jid) || null,
    lastText: (x => x ? `${x.sender_name ? `${x.sender_name}: ` : ''}${typeLabel(x.type, x.txt)}`.slice(0, 200) : '')(last.find(l => l.jid === r.jid)) })) };
});

// ---------------------------------------------------------------- API: messages and rate card
route('GET', '/api/ladder', async () => ladder.ladderState());
route('POST', '/api/ladder/package', async ({ body }) => ladder.savePackage(body));
route('DELETE', '/api/ladder/package/:id', async ({ params }) => ladder.deletePackage(intOf(params.id)));
route('POST', '/api/ladder/headings', async ({ body }) => ladder.saveHeadings(body.headings));
route('POST', '/api/ladder/rung', async ({ body }) => ladder.saveRung(body));
route('POST', '/api/ladder/rung/:id/move', async ({ params, body }) => ladder.moveRung(intOf(params.id), Number(body.dir) < 0 ? -1 : 1));
route('DELETE', '/api/ladder/rung/:id', async ({ params }) => ladder.deleteRung(intOf(params.id)));
route('POST', '/api/ladder/preview', async ({ body }) => {
  const st = await ladder.ladderState();
  const s = await getSettings();
  const rung = { template: String(body.template || ''), package_id: body.package_id ? Number(body.package_id) : null, label: 'preview' };
  const pkg = rung.package_id ? st.packages.find(p => p.id === rung.package_id) : null;
  return { problem: ladder.rungProblem(rung, st.packages),
    samples: (st.headings.length ? st.headings : [null]).map(h => ladder.renderRung(rung, pkg, h, s.business_name)) };
});

// ---------------------------------------------------------------- API: reports, settings, log, exports
route('GET', '/api/reports', async () => q(`select r.*, o.name owner_name from desk.reports r left join desk.owners o on o.id = r.owner_id order by r.id desc limit 100`));
route('POST', '/api/reports/rebuild/:id', async ({ params }) => { await buildReports(intOf(params.id)); return { ok: true }; });
route('POST', '/api/settings/test-chat', async ({ body, user }) => {
  const url = String(body.webhook || '').trim();
  if (!/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/\S+$/.test(url)) throw httpError(400, 'Not a Google Chat webhook URL');
  const err = await postChat(url, `WhatsApp Desk test message from ${user || 'the dashboard'}. The connection works.`);
  if (err) throw httpError(502, err);
  return { ok: true };
});
route('GET', '/api/settings', async () => getSettings());
route('PUT', '/api/settings', async ({ body, user }) => { const s = await saveSettings(body); await logEvent('settings.save', { keys: Object.keys(body) }, user); return s; });
route('GET', '/api/events', async ({ query }) => q(`select * from desk.events order by id desc limit $1`, [clampInt(query.get('limit'), 1, 1000, 200)]));
const EXPORTS = {
  'resellers.csv': [`select r.code, r.name, r.phone, r.company, r.city, r.email, o.name owner, r.stage, r.track, r.track_source, r.track_reason,
      r.call1_outcome, r.call1_at, r.call2_outcome, r.call2_at, r.first_offer_at, r.instance sender, r.group_jid,
      (select subject from desk.groups g where g.jid = r.group_jid and subject is not null limit 1) group_name,
      r.fu_batch, r.of_batch, r.last_msg_at, r.last_msg_by, r.last_ours_at, r.last_client_at, r.replied, r.last_reply_at, r.last_reply_text,
      r.paused, r.pause_reason, r.hold, r.dnc, r.left_group, r.notes, r.created_at
    from desk.resellers r left join desk.owners o on o.id = r.owner_id order by r.id`],
  'sends.csv': [`select l.sent_at, r.code, r.name, l.instance sender, l.jid, l.ring, l.rung_label, l.package_label, l.tagged, l.text, l.wa_msg_id, l.run_id
    from desk.send_log l left join desk.resellers r on r.id = l.reseller_id order by l.id`],
  'replies.csv': [`select y.ts, r.code, r.name, y.jid, y.sender, y.sender_name, y.text, y.signal, y.stop_word
    from desk.replies y left join desk.resellers r on r.id = y.reseller_id order by y.id`],
  'groups.csv': [`select n.label number, g.instance, g.jid, g.subject, g.size, g.left_group, r.code reseller
    from desk.groups g join desk.numbers n on n.instance = g.instance left join desk.resellers r on r.group_jid = g.jid order by n.sort, lower(g.subject)`],
};
route('GET', '/api/export/:file', async ({ params, res }) => {
  const e = EXPORTS[params.file];
  if (!e) throw httpError(404, 'Unknown export');
  const rows = await q(e[0]);
  const cols = rows.length ? Object.keys(rows[0]) : ['empty'];
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${params.file}"` });
  res.end('﻿' + toCsv(rows, cols));
  return undefined;
});
route('POST', '/api/run-worker/:name', async ({ params }) => {
  const w = workers.find(x => x.name === params.name);
  if (!w) throw httpError(404, 'Unknown worker');
  await runWorker(w.name, w.fn);
  return workerState[w.name];
});

// ---------------------------------------------------------------- test-only routes (DESK_TEST=1)
if (cfg.test) {
  route('GET', '/api/test/clock', async () => ({ now: now().toISOString(), ist: istDate() }));
  route('POST', '/api/test/clock', async ({ body }) => {
    if (body.iso) setClock(body.iso);
    if (body.advanceMs) advanceClock(Number(body.advanceMs));
    return { now: now().toISOString() };
  });
}

// ---------------------------------------------------------------- HTTP plumbing
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'The request is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'The request body is not JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'not found' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Deep links like /chats open the app shell.
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      return send(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': rel === '/index.html' ? 'no-store' : 'no-cache', ...SEC_HEADERS });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    // DNS-rebinding guard: only answer to the host names this desk is served on.
    if (!cfg.allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'Unknown host' });
    if (pathname === '/healthz') {
      const db = await one('select 1 ok').then(() => true).catch(() => false);
      return send(res, db ? 200 : 503, { ok: db, version: VERSION });
    }
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res, pathname);
    }
    const r = routes.find(x => x.method === req.method && x.re.test(pathname));
    if (!r) return send(res, 404, { error: 'No such API route' });
    // Cross-site request guard: every change must come from this page's own script.
    if (req.method !== 'GET') {
      if (req.headers['x-desk'] !== '1') return send(res, 403, { error: 'Missing request header' });
      const origin = req.headers.origin;
      if (origin) {
        let host = ''; try { host = new URL(origin).host.toLowerCase(); } catch {}
        if (!cfg.allowedHosts.has(host)) return send(res, 403, { error: 'Cross-site request refused' });
      }
    }
    const user = await sessionUser(req);
    if (!r.public && !user) return send(res, 401, { error: 'Please log in' });
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req, r.limit || (1 << 20)) : {};
    const out = await r.handler({ req, res, params, query: url.searchParams, body, user });
    if (out !== undefined) send(res, 200, out);
  } catch (e) {
    const status = e.status || (e.evoStatus ? 502 : 500);
    if (status >= 500) console.error('[api]', req.method, pathname, e.stack || e.message);
    send(res, status, { error: e.message || 'Something went wrong' });
  }
});

// ---------------------------------------------------------------- plugins
// Any .mjs file in src/plugins that exports register({ route, every, q, one, logEvent, getSettings })
// is loaded at start. See docs/EXTENDING.md.
async function loadPlugins() {
  const dir = path.join(HERE, 'plugins');
  if (!fs.existsSync(dir)) return [];
  const loaded = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.mjs')).sort()) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      if (typeof mod.register === 'function') {
        await mod.register({ route: (m, p, h, o) => route(m, p.startsWith('/api/') ? p : `/api/plugins${p}`, h, o), every, q, one, logEvent, getSettings, cfg });
        loaded.push(f);
      }
    } catch (e) { console.error(`[plugin ${f}]`, e.message); }
  }
  return loaded;
}

// ---------------------------------------------------------------- start
every(5000, 'sender', workerTick, { firstAfter: 8000 });
every(3 * 60000, 'read', readCycle, { firstAfter: 4000 });
every(60000, 'alerts', notifyAlerts, { firstAfter: 20000 });
every(5 * 60000, 'day-close', closeRestDay, { firstAfter: 60000 });
every(6 * 3600000, 'cleanup', async () => { await q(`delete from desk.sessions where expires_at < now()`); return { ok: true }; });

// On a fresh server the desk can start before Evolution has created its tables.
async function waitForEvolutionTables() {
  for (let i = 0; ; i++) {
    const ok = await one(`select to_regclass('evolution_api."Message"') is not null ok`).then(r => r?.ok).catch(() => false);
    if (ok) return;
    if (i % 6 === 0) console.log('[desk] waiting for Evolution to create its database tables...');
    await new Promise(r => setTimeout(r, 5000));
  }
}

async function main() {
  await waitForEvolutionTables();
  await migrate();
  await ladder.seedLadder();
  const plugins = await loadPlugins();
  if (plugins.length) console.log('[desk] plugins:', plugins.join(', '));
  route('GET', '/api/workers', async () => ({ workers: workers.map(w => ({ name: w.name, everyMs: w.ms, ...workerState[w.name] })), plugins }));
  // A send that was in flight when the desk stopped may or may not have reached WhatsApp.
  // It is never retried blindly: it is marked failed and its run stops (85).
  const stuck = await q(`update desk.sends set status = 'failed', error = 'the desk restarted while this message was being sent - check the group before sending it again'
    where status = 'sending' returning run_id`);
  for (const id of new Set(stuck.map(x => x.run_id))) await stopRun(id, 'the desk restarted in the middle of a send').catch(() => {});
  server.listen(cfg.port, cfg.host, () => console.log(`[desk] v${VERSION} on http://${cfg.host}:${cfg.port} (auth ${authRequired() ? 'on' : 'off'}${cfg.test ? ', TEST MODE' : ''})`));
  if (cfg.workersEnabled) {
    for (const w of workers) {
      setTimeout(() => { runWorker(w.name, w.fn); setInterval(() => runWorker(w.name, w.fn), w.ms); }, w.firstAfter);
    }
  }
}

const shutdown = () => { server.close(); pool.end().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
main().catch(e => { console.error('[desk] failed to start:', e); process.exit(1); });
