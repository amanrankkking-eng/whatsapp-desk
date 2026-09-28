// End-to-end test of the reseller flow, Stage 0 to Stage 12, against a throwaway database and a
// mock Evolution API. A movable clock walks the calendar. Nothing reaches WhatsApp or Google.
//
//   TEST_ADMIN_DB_URL=postgresql://user:pass@127.0.0.1:5432/postgres node --test test/
//
// On the Mac the admin URL is read from ~/Claude/evolution-local/.pgpass.env when not set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import pg from 'pg';
import { startMockEvolution } from './mock-evolution.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESK_PORT = 18092, MOCK_PORT = 18080, KEY = 'test-evolution-key';
const USER = 'admin', PASS = 'test-password-123';

function adminUrl() {
  if (process.env.TEST_ADMIN_DB_URL) return process.env.TEST_ADMIN_DB_URL;
  const f = path.join(process.env.HOME, 'Claude/evolution-local/.pgpass.env');
  const pw = fs.readFileSync(f, 'utf8').match(/PG_PASSWORD=(.*)/)[1].trim().replace(/^['"]|['"]$/g, '');
  return `postgresql://evolution:${encodeURIComponent(pw)}@127.0.0.1:5433/evolution`;
}
const testDbUrl = () => { const u = new URL(adminUrl()); u.pathname = '/desk_test'; return u.toString(); };

let mock, desk, cookie = '', db;
const deskLog = [];

async function api(method, p, body, { raw = false, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${DESK_PORT}${p}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-desk': '1', cookie, ...headers },
  });
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(`${method} ${p} -> ${res.status}: ${data?.error}`); e.status = res.status; e.data = data; throw e; }
  return data;
}
const mockCall = async (p, body, method = 'POST') => (await fetch(`${mock.url}/mock/${p}`, { method, headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined })).json();
// IST wall-clock time -> both clocks.
async function at(isoIst) {
  const iso = new Date(`${isoIst}+05:30`).toISOString();
  await api('POST', '/api/test/clock', { iso });
  await mockCall('clock', { iso });
}
const tick = name => api('POST', `/api/run-worker/${name}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rowByCode = async code => (await api('GET', '/api/resellers')).find(r => r.code === code);

// People in the scenario (made-up numbers).
const P = {
  reader: '919000000100', a: '919000000101', b: '919000000102', c: '919000000103', aman: '919000000200',
  ravi: '919811111101', sunita: '919811111102', karan: '919811111103', meena: '919811111104', arjun: '919811111105',
  deepak: '919811111106', stranger: '918888000001', wire: '918888000002',
};
const G = { g1: '120363000000000001@g.us', g2: '120363000000000002@g.us', g3: '120363000000000003@g.us', g4: '120363000000000004@g.us',
  g5: '120363000000000005@g.us', g6: '120363000000000006@g.us', g7: '120363000000000007@g.us' };
const TEAM_HOOK = 'https://chat.googleapis.com/v1/spaces/TEAM/messages?key=k&token=t';
const OWNER_HOOK = 'https://chat.googleapis.com/v1/spaces/ROSHAN/messages?key=k&token=t';

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = 'desk_test' and pid <> pg_backend_pid()`);
  await admin.query('drop database if exists desk_test');
  await admin.query('create database desk_test');
  await admin.end();
  db = new pg.Client({ connectionString: testDbUrl() });
  await db.connect();
  await db.query(fs.readFileSync(path.join(HERE, 'evolution-schema.sql'), 'utf8'));
  mock = await startMockEvolution({ port: MOCK_PORT, databaseUrl: testDbUrl(), apiKey: KEY });
  desk = spawn(process.execPath, [path.join(HERE, '..', 'src', 'server.mjs')], {
    env: { ...process.env, DATABASE_URL: testDbUrl(), EVO_URL: mock.url, EVO_API_KEY: KEY, PORT: String(DESK_PORT), HOST: '127.0.0.1',
      DESK_TEST: '1', DESK_WORKERS: '0', DESK_USER: USER, DESK_PASSWORD: PASS, TEST_CHAT_SINK: `${mock.url}/chat-sink` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  desk.stdout.on('data', d => deskLog.push(String(d)));
  desk.stderr.on('data', d => deskLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${DESK_PORT}/healthz`)).ok) break; } catch {}
    await sleep(100);
  }
});

after(async () => {
  desk?.kill('SIGTERM');
  await mock?.close();
  await db?.end();
  if (process.env.SHOW_DESK_LOG) console.log(deskLog.join(''));
});

test('security: host, cross-site and login guards', async () => {
  const hostStatus = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: DESK_PORT, path: '/api/me', headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 421, 'unknown Host header is refused (DNS rebinding)');
  let r = await api('GET', '/api/overview', undefined, { raw: true });
  assert.equal(r.status, 401, 'API needs a login');
  r = await fetch(`http://127.0.0.1:${DESK_PORT}/api/login`, { method: 'POST', body: JSON.stringify({ user: USER, password: PASS }) });
  assert.equal(r.status, 403, 'a change without the x-desk header is refused');
  r = await api('POST', '/api/login', { user: USER, password: 'wrong' }, { raw: true });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/login', { user: USER, password: PASS }, { raw: true, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403, 'a foreign Origin is refused');
  r = await api('POST', '/api/login', { user: USER, password: PASS }, { raw: true });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const me = await api('GET', '/api/me');
  assert.equal(me.user, USER);
  r = await fetch(`http://127.0.0.1:${DESK_PORT}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

test('Stage 0: four WhatsApp numbers are added from the dashboard (QR and pairing code)', async () => {
  await at('2026-09-21T11:00:00');
  const add = async (label, role, phone, name, withCode) => {
    const r = await api('POST', '/api/numbers', { label, role, ...(withCode ? { phone: phone.slice(2) } : {}) });
    if (withCode) assert.equal(r.pairingCode, 'WZYX1234', 'pairing code comes back when a phone number is given');
    else assert.ok(r.qr?.startsWith('data:image/png;base64,'), 'QR comes back for scanning');
    const link = await api('GET', `/api/numbers/${r.instance}/link`);
    assert.equal(link.state, 'connecting');
    await mockCall('link', { instance: r.instance, phone, name });
    const done = await api('GET', `/api/numbers/${r.instance}/link`);
    assert.equal(done.state, 'open');
    return r.instance;
  };
  assert.equal(await add('Reader', 'reader', P.reader, 'Rankkking Reader'), 'wa-reader');
  assert.equal(await add('Sender A', 'sender', P.a, 'Priya'), 'wa-sendera');
  assert.equal(await add('Sender B', 'sender', P.b, 'Neha'), 'wa-senderb');
  assert.equal(await add('Sender C', 'sender', P.c, 'Kabir', true), 'wa-senderc');
  // First read: each number's first group sync (it holds no groups yet, so nothing counts as pre-existing).
  await tick('read');
  const nums = await api('GET', '/api/numbers');
  assert.equal(nums.length, 4);
  assert.deepEqual(nums.map(n => [n.instance, n.role, n.state, n.phone]), [
    ['wa-reader', 'reader', 'open', P.reader], ['wa-sendera', 'sender', 'open', P.a],
    ['wa-senderb', 'sender', 'open', P.b], ['wa-senderc', 'sender', 'open', P.c]]);
  // The same name twice gets its own instance, never a clash.
  const dup = await api('POST', '/api/numbers', { label: 'Sender A', role: 'sender' });
  assert.equal(dup.instance, 'wa-sendera-2');
  // A closed connection is restarted only on request, and never twice within 30 seconds
  // (two sockets for one number kick each other off until WhatsApp removes the device).
  await mockCall('state', { instance: 'wa-sendera-2', state: 'close' });
  assert.equal((await api('GET', '/api/numbers/wa-sendera-2/link')).needsStart, true, 'polling never restarts a connection');
  const started = await api('GET', '/api/numbers/wa-sendera-2/link?start=1');
  assert.ok(started.qr, 'asking for a new QR starts one connection');
  await mockCall('state', { instance: 'wa-sendera-2', state: 'close' });
  assert.equal((await api('GET', '/api/numbers/wa-sendera-2/link?start=1')).starting, true, 'no second start within 30 seconds');
  await mockCall('state', { instance: 'wa-sendera', state: 'close' });
  assert.equal((await api('GET', '/api/numbers/wa-sendera/link?start=1')).reconnecting, true, 'a number that was just connected is left to reconnect by itself');
  await mockCall('state', { instance: 'wa-sendera', state: 'open' });
  await api('DELETE', '/api/numbers/wa-sendera-2');
  assert.equal((await api('GET', '/api/numbers')).length, 4);
});

test('Stage 0: settings, owner, rate card, never-send list', async () => {
  await assert.rejects(api('PUT', '/api/settings', { team_chat_webhook: 'https://example.com/hook' }), /Google Chat/);
  await assert.rejects(api('PUT', '/api/settings', { gap_min_sec: 900, gap_max_sec: 600 }), /maximum gap/);
  const s = await api('PUT', '/api/settings', { team_numbers: { [P.aman]: 'Aman' }, team_chat_webhook: TEAM_HOOK });
  assert.equal(s.min_gap_days, 10);
  assert.deepEqual(s.send_days, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  assert.equal(s.window_start, '10:30');
  assert.equal(s.window_end, '17:30');
  await api('POST', '/api/owners', { name: 'Roshan', phone: '9000000300', chat_webhook: OWNER_HOOK });
  const owners = await api('GET', '/api/owners');
  assert.equal(owners[0].phone, '919000000300');
  const lad = await api('GET', '/api/ladder');
  assert.equal(lad.headings.length, 5, 'five heading styles');
  assert.deepEqual(lad.rungs.filter(r => r.ring === 'follow_up').map(r => r.label), ['F1-checkin', 'F2-useful', 'F3-question', 'F4-proof', 'F5-close']);
  // 70: an outlet marked unavailable is dropped from the text.
  const p1 = lad.packages.find(p => p.label === 'Package 1');
  await api('POST', '/api/ladder/package', { ...p1, outlets: p1.outlets.map(o => ({ name: o.name, available: o.name !== 'Digital Journal' })) });
  const prev = await api('POST', '/api/ladder/preview', { template: lad.rungs.find(r => r.label === 'O1-entry').template, package_id: p1.id });
  assert.equal(prev.problem, null);
  assert.equal(prev.samples.length, 5);
  for (const t of prev.samples) {
    assert.ok(t.includes('Yahoo Finance') && !t.includes('Digital Journal'), 'unavailable outlet dropped');
    assert.ok(!/Package \d/.test(t), 'package number never appears in the text');
  }
  assert.equal(new Set(prev.samples.map(t => t.split('\n')[0])).size, 5, 'each heading style reads differently');
  // 72 / placeholder guard: bracketed copy is never sent.
  const bad = await api('POST', '/api/ladder/preview', { template: 'Hello [write the offer here]' });
  assert.match(bad.problem, /unfinished/);
});

test('Stage 1: leads come in, numbers normalised, duplicates and bad rows rejected with a reason', async () => {
  const csv = `Name,Phone,Company,City,Owner
Ravi,98111 11101,Ravi PR,Delhi,Roshan
Sunita,+91 98111-11102,SK Media,Pune,roshan
Karan,09811111103,KP,Mumbai,Roshan
Meena,9811111104,,Jaipur,Roshan
Arjun,9811111105,,Agra,Roshan
Deepak,919811111106,,Noida,Roshan
Ravi again,9811111101,,Delhi,Roshan
Nobody,abc123,,,
Short,12345,,,`;
  const r = await api('POST', '/api/resellers/import', { csv, source: 'Ankush sheet' });
  assert.deepEqual(r.added.map(x => [x.code, x.phone]), [
    ['R0001', P.ravi], ['R0002', P.sunita], ['R0003', P.karan], ['R0004', P.meena], ['R0005', P.arjun], ['R0006', P.deepak]]);
  assert.deepEqual(r.rejected.map(x => x.reason), ['appears twice in this import', 'contains letters', '5 digits is not a phone number']);
  const again = await api('POST', '/api/resellers/import', { csv: 'phone\n9811111101' });
  assert.match(again.rejected[0].reason, /already a row \(R0001\)/, '21: a lead already in the sheet is dropped with the reason');
  const rows = await api('GET', '/api/resellers');
  assert.ok(rows.every(x => x.owner_name === 'Roshan'), '13: every row has its owner');
  const id = code => rows.find(x => x.code === code).id;
  for (const c of ['R0001', 'R0002', 'R0003', 'R0004', 'R0006']) {
    assert.equal((await api('POST', `/api/resellers/${id(c)}/call`, { call: 1, outcome: 'Interested' })).stage, 'called_1');
  }
  assert.equal((await api('POST', `/api/resellers/${id('R0005')}/call`, { call: 1, outcome: 'Wrong number' })).stage, 'invalid', '122: wrong number is invalid');
});

test('Stage 1-2: groups are created, first offers go by hand, call 2 is the switch, groups bind by phone', async () => {
  const group = (jid, subject, members) => mockCall('group', { jid, subject, members });
  await group(G.g1, 'R0001 Ravi x Rankkking', [P.reader, P.a, P.aman, P.ravi]);
  await group(G.g2, 'Sunita - Rankkking', [P.reader, P.b, P.sunita]);
  await group(G.g3, 'R0003 Karan', [P.reader, P.a, P.b, P.karan]);
  await group(G.g4, 'Random chat', [P.reader, P.c, P.stranger]);
  await group(G.g5, 'Test group', [P.reader, P.c, P.meena]);
  await group(G.g6, 'R0006 Deepak', [P.reader, P.c, P.deepak]);
  await group(G.g7, 'Prime view - 01 Wire', [P.reader, P.a, P.wire]);
  // 27: the first offer is sent by a person, once, from the dashboard inbox.
  await api('POST', `/api/chats/wa-sendera/${encodeURIComponent(G.g1)}/send`, { text: 'Hi Ravi, here is our first offer.' });
  await api('POST', `/api/chats/wa-senderb/${encodeURIComponent(G.g2)}/send`, { text: 'Hi Sunita, here is our first offer.' });
  await api('POST', `/api/chats/wa-sendera/${encodeURIComponent(G.g3)}/send`, { text: 'Hi Karan, here is our first offer.' });
  await mockCall('message', { jid: G.g1, from: P.aman, text: 'Welcome Ravi, Aman here from the team.' });
  await at('2026-09-21T12:00:00');
  await mockCall('message', { jid: G.g3, from: P.karan, text: 'What is the price for Yahoo Finance?' });
  // Before call 2, the automation cannot touch a group (31).
  await tick('read');
  let r1 = await rowByCode('R0001');
  assert.equal(r1.group_jid, G.g1, 'bound by member phone');
  assert.equal(r1.instance, 'wa-sendera', 'the sender in the group owns it');
  assert.equal(r1.stage, 'offer_sent');
  const plan = (await api('GET', '/api/today')).plan;
  assert.equal(plan.items.length, 0);
  const rows = await api('GET', '/api/resellers');
  for (const c of ['R0001', 'R0002', 'R0003', 'R0004', 'R0006']) {
    assert.equal((await api('POST', `/api/resellers/${rows.find(x => x.code === c).id}/call`, { call: 2, outcome: 'Interested' })).stage, 'live');
  }
  await tick('read');
  r1 = await rowByCode('R0001');
  const r2 = await rowByCode('R0002'), r3 = await rowByCode('R0003'), r4 = await rowByCode('R0004'), r6 = await rowByCode('R0006');
  assert.equal(r2.group_jid, G.g2);
  assert.equal(r2.instance, 'wa-senderb');
  assert.equal(r6.group_jid, G.g6);
  assert.equal(r3.group_jid, null, '37: two sender numbers in one group - nothing is bound');
  assert.equal(r4.group_jid, null, '12: a never-send room is never bound');
  // 40: one batch of each ring, half a ring apart (ring padded to 16 batches).
  assert.equal(r1.fu_batch, 1);
  assert.equal(r1.of_batch, 9);
  const issues = await api('GET', '/api/bind-issues');
  assert.deepEqual(issues.map(i => i.jid).sort(), [G.g3, G.g4].sort(), 'only the two real problems are reported; the 01Wire group never is');
  assert.match(issues.find(i => i.jid === G.g3).reason, /2 sender numbers/);
  assert.match(issues.find(i => i.jid === G.g4).reason, /no member matches/);
  // A person binds Karan's group by hand.
  await api('POST', `/api/resellers/${r3.id}/bind`, { instance: 'wa-sendera', jid: G.g3 });
  await tick('read');
  assert.equal((await api('GET', '/api/bind-issues')).length, 1);
  const r3b = await rowByCode('R0003');
  assert.equal(r3b.group_jid, G.g3);
  // 47-48: status read from the chat.
  assert.equal(r1.track, 'follow_up');
  assert.equal(r1.track_source, 'chat');
  assert.equal(r3b.track, 'offer', 'asked the price - offer ring');
  assert.match(r3b.track_reason, /asked the price/);
  assert.equal(r6.track, null, '50: an unreadable chat gets no status');
  // 107/115: the teammate's message is ours, never a reply.
  assert.equal(r1.replied, false);
  // Karan's question is unanswered: paused and his owner is alerted by name.
  assert.equal(r3b.paused, true);
  const alerts = await api('GET', '/api/alerts');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, 'R0003');
  assert.equal(alerts[0].owner_name, 'Roshan');
});

test('Stage 11: alerts go to the owner by name, repeat until acknowledged, and record who acknowledged', async () => {
  await mockCall('chat-sink', null, 'DELETE');
  await tick('alerts');
  let sink = await mockCall('chat-sink', null, 'GET');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].to, OWNER_HOOK, 'the alert goes to the owner, not the room');
  assert.match(sink[0].text, /\*Roshan\*: Karan \(R0003\) replied/);
  assert.match(sink[0].text, /What is the price for Yahoo Finance\?/);
  await at('2026-09-21T12:10:00');
  await tick('alerts');
  assert.equal((await mockCall('chat-sink', null, 'GET')).length, 1, 'no repeat within 30 minutes');
  await at('2026-09-21T12:31:00');
  await tick('alerts');
  sink = await mockCall('chat-sink', null, 'GET');
  assert.equal(sink.length, 2, 'repeats until acknowledged');
  assert.match(sink[1].text, /Reminder 2/);
  // 116: a person answers; Claude never does.
  await api('POST', `/api/chats/wa-sendera/${encodeURIComponent(G.g3)}/send`, { text: 'Hi Karan, Yahoo Finance is $125 this week.' });
  const a = (await api('GET', '/api/alerts'))[0];
  await api('POST', `/api/alerts/${a.id}/ack`);
  const all = await api('GET', '/api/alerts?show=all');
  assert.equal(all[0].acked_by, USER, '113: who acknowledged is recorded');
  assert.ok(all[0].acked_at);
  await at('2026-09-21T13:10:00');
  await tick('alerts');
  assert.equal((await mockCall('chat-sink', null, 'GET')).length, 2, 'acknowledged alerts stop repeating');
  // 117: the person marks the row when the conversation is over.
  const r3 = await rowByCode('R0003');
  await api('POST', `/api/resellers/${r3.id}/action`, { action: 'resume' });
  assert.equal((await rowByCode('R0003')).paused, false);
  // 45: a status written by a person wins.
  const r6 = await rowByCode('R0006');
  await api('POST', `/api/resellers/${r6.id}/track`, { track: 'offer' });
  await tick('read');
  const r6b = await rowByCode('R0006');
  assert.equal(r6b.track, 'offer');
  assert.equal(r6b.track_source, 'manual', 'the read never overrules a person');
});

test('Stage 3-8: the day is previewed, approved, sent one at a time per number, and recorded', async () => {
  await at('2026-10-05T09:30:00');   // Monday, 14 days later
  await tick('read');
  // 5: numbers added on the 21st are still warming up; a person can end the warm-up by hand.
  const warm = (await api('GET', '/api/today')).plan;
  assert.equal(warm.items.length, 0);
  assert.match(warm.skips.find(s => s.code === 'R0001').reason, /Sender A is still warming up \(day 15 of 21\)/);
  for (const n of ['wa-sendera', 'wa-senderb', 'wa-senderc']) await api('PATCH', `/api/numbers/${n}`, { warmed: true });
  const { plan } = await api('GET', '/api/today');
  assert.equal(plan.isSendDay, true);
  assert.equal(plan.batches.follow_up, 1);
  assert.equal(plan.batches.offer, 1);
  assert.deepEqual(plan.items.map(i => i.code).sort(), ['R0001', 'R0002']);
  const i1 = plan.items.find(i => i.code === 'R0001');
  assert.equal(i1.sender, 'Sender A', '80: the group hears from its own sender');
  assert.equal(i1.rungLabel, 'F1-checkin');
  assert.equal(i1.tag.phone, P.ravi, '73: the reseller is tagged');
  assert.ok(i1.text.startsWith(`Hi @${P.ravi}\n\nQuick check-in`), i1.text);
  assert.match(i1.why, /batch 1 runs today; F1-checkin is the next message/);
  assert.equal(i1.scheduledAt, new Date('2026-10-05T10:30:00+05:30').toISOString(), 'first send at 10:30');
  assert.ok(!plan.items.some(i => i.text.includes(P.aman)), '75: a team number is never tagged');
  // 79: nothing has gone before approval.
  assert.equal(mock.sent.length, 4, 'only what people sent by hand so far: three first offers and one answer');
  mock.sent.splice(0);
  const ap = await api('POST', '/api/today/approve', { ids: plan.items.map(i => i.id) });
  assert.equal(ap.queued, 2);
  const mid = (await api('GET', '/api/today')).plan;
  assert.equal(mid.items.length, 0, 'approved groups are never offered for approval twice');
  assert.equal(mid.inRun.length, 2);
  await assert.rejects(api('POST', '/api/today/approve', { ids: [] }), /still sending/, 'no second run while one is sending');
  await tick('sender');
  assert.equal(mock.sent.length, 0, '83: nothing goes before 10:30');
  await at('2026-10-05T10:31:00');
  await tick('sender');
  assert.equal(mock.sent.length, 2, 'both lanes send side by side, one message each');
  assert.deepEqual(mock.sent.map(x => x.instance).sort(), ['wa-sendera', 'wa-senderb']);
  assert.deepEqual(mock.sent.find(x => x.instance === 'wa-sendera').mentioned, [P.ravi]);
  await tick('sender');
  const runs = await api('GET', '/api/runs');
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].sent, 2);
  // 86-89: the append-only record.
  const log = (await db.query(`select * from desk.send_log order by id`)).rows;
  assert.equal(log.length, 2);
  assert.ok(log.every(l => l.rung_label === 'F1-checkin' && l.wa_msg_id && l.instance && l.tagged));
  // 54-55: both counters moved because the batch ran.
  const ring = (await db.query(`select ring, last_batch, last_run_date::text d from desk.ring_state order by ring`)).rows;
  assert.deepEqual(ring, [{ ring: 'follow_up', last_batch: 1, d: '2026-10-05' }, { ring: 'offer', last_batch: 1, d: '2026-10-05' }]);
  // 91-98: the team summary and the owner brief.
  const sink = await mockCall('chat-sink', null, 'GET');
  const team = sink.filter(x => x.to === TEAM_HOOK).pop();
  assert.match(team.text, /Sent: \*2\*/);
  const brief = sink.filter(x => x.to === OWNER_HOOK).pop();
  assert.match(brief.text, /Roshan - your brief/);
  // Double ticks: receipts come in and the inbox shows them.
  await sleep(600);
  const thread = await api('GET', `/api/chats/wa-sendera/${encodeURIComponent(G.g1)}`);
  const last = thread.messages[thread.messages.length - 1];
  assert.equal(last.fromMe, true);
  assert.equal(last.status, 'READ', 'every member read it: blue double tick');
  const list = await api('GET', '/api/chats?instance=wa-sendera');
  assert.equal(list.find(c => c.jid === G.g1).lastStatus, 'READ');
  // 88: approving the same day again sends nothing twice.
  const again = (await api('GET', '/api/today')).plan;
  assert.equal(again.items.length, 0);
  assert.ok(again.skips.some(s => s.code === 'R0001' && /gap/.test(s.check)));
  await api('POST', '/api/today/approve', { ids: [i1.id] });
  await tick('sender');
  assert.equal(mock.sent.length, 2);
});

test('Stage 7: gaps between sends on one number are random, 5-14 minutes, never a round minute', async () => {
  const { randomGapSec } = await import('../src/util.mjs');
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const g = randomGapSec(301, 840);
    assert.ok(g >= 301 && g <= 840);
    assert.notEqual(g % 60, 0);
    seen.add(g);
  }
  assert.ok(seen.size > 400, 'the gaps really vary');
});

test('Stage 11: stop words, bursts of messages, and our own messages', async () => {
  await at('2026-10-06T10:00:00');
  await mockCall('chat-sink', null, 'DELETE');
  // 115: our own message in a group never raises anything.
  await api('POST', `/api/chats/wa-sendera/${encodeURIComponent(G.g1)}/send`, { text: 'A note from our side' });
  await tick('read');
  const before = await rowByCode('R0001');
  assert.equal(before.paused, false, '115: nothing fires after one of our own messages');
  assert.equal((await api('GET', '/api/alerts')).length, 0);
  await at('2026-10-06T10:05:00');
  await mockCall('message', { jid: G.g1, from: P.ravi, text: 'Please stop sending these messages' });
  for (let i = 1; i <= 5; i++) await mockCall('message', { jid: G.g2, from: P.sunita, text: `message ${i} from Sunita` });
  await tick('read');
  const r1 = await rowByCode('R0001'), r2 = await rowByCode('R0002');
  assert.equal(r1.dnc, true, '119: stop sets do-not-contact');
  assert.equal(r1.stage, 'dnc');
  assert.equal(r2.paused, true, '108: a reply pauses the ladder at once');
  assert.match(r2.last_reply_text, /message 5 from Sunita/, '109: the reply is written onto the row');
  const open = await api('GET', '/api/alerts');
  assert.equal(open.length, 2);
  assert.equal(open.find(a => a.code === 'R0002').count, 5, '114: five messages in a row are one alert');
  assert.equal(open.find(a => a.code === 'R0001').kind, 'stop');
  const replies = (await db.query(`select count(*)::int n from desk.replies where reseller_id = $1`, [r2.id])).rows[0].n;
  assert.equal(replies, 5, '89: every reply is recorded');
  await tick('alerts');
  assert.equal((await mockCall('chat-sink', null, 'GET')).length, 2);
  // The replies page counts today's replies per group, for every group.
  const day = await api('GET', '/api/replies?day=2026-10-06');
  assert.equal(day.groups.find(g => g.jid === G.g2).replies, 5);
  assert.equal(day.groups.find(g => g.jid === G.g2).reseller.code, 'R0002');
  for (const a of open) await api('POST', `/api/alerts/${a.id}/ack`);
  await api('POST', `/api/resellers/${r2.id}/action`, { action: 'resume' });
});

test('Stage 10: rest days close by themselves; a day waiting for approval never does', async () => {
  // Tue 6 Oct: batches 2/2 hold nobody, so the day closes itself after 17:30.
  await at('2026-10-06T17:00:00');
  assert.equal((await tick('day-close')).lastResult.closed, false, 'not before the window closes');
  await at('2026-10-06T17:45:00');
  assert.equal((await tick('day-close')).lastResult.closed, true);
  let ring = (await db.query(`select last_batch from desk.ring_state order by ring`)).rows.map(r => r.last_batch);
  assert.deepEqual(ring, [2, 2]);
  // Saturday is not a send day: nothing moves.
  await at('2026-10-10T18:00:00');
  assert.equal((await tick('day-close')).lastResult.closed, false);
  await assert.rejects(api('POST', '/api/today/approve', { ids: [] }), /not a send day/);
  // Walk the week days until the offer ring reaches batch 9.
  for (const d of ['07', '08', '09', '12', '13', '14']) {
    await at(`2026-10-${d}T18:00:00`);
    assert.equal((await tick('day-close')).lastResult.closed, true, `rest day 2026-10-${d}`);
  }
  ring = (await db.query(`select last_batch from desk.ring_state order by ring`)).rows.map(r => r.last_batch);
  assert.deepEqual(ring, [8, 8]);
});

test('Stage 5-6: the offer ring, the six checks and the rate card', async () => {
  await at('2026-10-15T09:00:00');   // Thursday, offer batch 9
  await tick('read');
  const { plan } = await api('GET', '/api/today');
  assert.equal(plan.batches.offer, 9);
  const item = plan.items.find(i => i.code === 'R0003');
  assert.ok(item, 'Karan is due in the offer ring');
  assert.equal(item.rungLabel, 'O1-entry');
  assert.ok(item.text.includes('Yahoo Finance') && !item.text.includes('Digital Journal') && !/Package \d/.test(item.text));
  assert.equal(item.tag.phone, P.karan);
  const deepak = plan.skips.find(s => s.code === 'R0006');
  assert.equal(deepak.check, 'readable', '63: an empty read is unknown, never quiet');
  // 67: a group on hold never reaches the checks.
  const r3 = await rowByCode('R0003');
  await api('POST', `/api/resellers/${r3.id}/action`, { action: 'hold' });
  let p2 = (await api('GET', '/api/today')).plan;
  assert.equal(p2.skips.find(s => s.code === 'R0003').reason, 'on hold');
  await api('POST', `/api/resellers/${r3.id}/action`, { action: 'unhold' });
  // 84: the per-number cap.
  await api('PATCH', '/api/numbers/wa-sendera', { daily_cap: 0 });
  p2 = (await api('GET', '/api/today')).plan;
  assert.match(p2.skips.find(s => s.code === 'R0003').reason, /daily cap of 0/);
  await api('PATCH', '/api/numbers/wa-sendera', { daily_cap: 10 });
  // 85: the first API error stops the run; nothing else goes and the counters stay.
  await api('POST', '/api/today/approve', { ids: [item.id] });
  await mockCall('fail-next', { status: 500, message: 'rate-overlimit' });
  await at('2026-10-15T10:31:00');
  await tick('sender');
  let run = (await api('GET', '/api/runs'))[0];
  assert.equal(run.status, 'stopped');
  assert.match(run.stop_reason, /first API error/);
  let ring = (await db.query(`select last_batch from desk.ring_state order by ring`)).rows.map(r => r.last_batch);
  assert.deepEqual(ring, [8, 8], '54: a stopped run never costs anyone their turn');
  // Next day the same batch comes round again and goes through.
  await at('2026-10-16T10:00:00');
  const p3 = (await api('GET', '/api/today')).plan;
  assert.equal(p3.batches.offer, 9);
  await api('POST', '/api/today/approve', { ids: p3.items.map(i => i.id) });
  await at('2026-10-16T10:31:00');
  await tick('sender');
  run = (await api('GET', '/api/runs'))[0];
  assert.equal(run.status, 'done');
  ring = (await db.query(`select last_batch from desk.ring_state order by ring`)).rows.map(r => r.last_batch);
  assert.deepEqual(ring, [9, 9]);
  const sentO1 = mock.sent.filter(x => x.text.includes('Yahoo Finance'));
  assert.equal(sentO1.length, 1);
});

test('Stage 12: order placed, exhausted and revived, reseller left, lost sender and slice move', async () => {
  // 118: order placed leaves the rings.
  const r6 = await rowByCode('R0006');
  await api('POST', `/api/resellers/${r6.id}/action`, { action: 'order_placed' });
  assert.equal((await rowByCode('R0006')).stage, 'active_reseller');
  // 121: the reseller leaves the group - paused, a person is told, never re-bound.
  await mockCall('group/remove', { jid: G.g2, phone: P.sunita });
  await api('POST', '/api/numbers/wa-senderb/refresh-groups');
  await tick('read');
  const r2 = await rowByCode('R0002');
  assert.equal(r2.paused, true);
  assert.equal(r2.left_group, true);
  assert.equal(r2.group_jid, G.g2, 'never re-bound to whoever is left');
  assert.ok((await api('GET', '/api/alerts')).some(a => a.code === 'R0002' && a.kind === 'left'));
  // 120/123: every message used - exhausted; a new message brings it back.
  const lad = await api('GET', '/api/ladder');
  const karan = await rowByCode('R0003');
  for (const r of lad.rungs.filter(x => x.ring === 'offer' && x.label !== 'O1-entry')) {
    await api('POST', '/api/ladder/rung', { ...r, active: false });
  }
  // Put Karan's offer batch back on today to see the exhaustion.
  await db.query(`update desk.ring_state set last_batch = 8, last_run_date = null`);
  await at('2026-10-19T09:30:00');
  const p = (await api('GET', '/api/today')).plan;
  assert.ok(p.exhausted.some(x => x.code === 'R0003'));
  await api('POST', '/api/today/approve', { ids: [] });
  assert.equal((await rowByCode('R0003')).stage, 'exhausted', 'reported as exhausted, never as converted');
  await api('POST', '/api/ladder/rung', { ring: 'offer', label: 'O4-new', template: 'A brand new offer from us. Say stop any time.' });
  assert.equal((await rowByCode('R0003')).stage, 'live', '123: a new message brings an exhausted group back');
  // A label that was already sent can never be renamed.
  const f1 = lad.rungs.find(r => r.label === 'F1-checkin');
  await assert.rejects(api('POST', '/api/ladder/rung', { ...f1, label: 'F1-renamed' }), /cannot change/);
  // 125-127: a sender is lost. Only its slice stops; the slice moves and opens with an intro.
  await mockCall('state', { instance: 'wa-sendera', state: 'close' });
  await db.query(`update desk.ring_state set last_batch = 8, last_run_date = null`);
  await at('2026-10-27T09:30:00');   // past Karan's 10-day gap from the 16th
  let plan = (await api('GET', '/api/today')).plan;
  assert.match(plan.skips.find(s => s.code === 'R0003').reason, /Sender A is close/);
  await assert.rejects(api('DELETE', '/api/numbers/wa-sendera'), /still owns/);
  const moved = await api('POST', '/api/numbers/move-slice', { from: 'wa-sendera', to: 'wa-senderc' });
  assert.equal(moved.moved, 2);
  plan = (await api('GET', '/api/today')).plan;
  assert.match(plan.skips.find(s => s.code === 'R0003').reason, /Sender C is not in this group/, 'the new sender must be added to the group first');
  await mockCall('group/add', { jid: G.g3, phone: P.c });
  await api('POST', '/api/numbers/wa-senderc/refresh-groups');
  plan = (await api('GET', '/api/today')).plan;
  const it = plan.items.find(i => i.code === 'R0003');
  assert.ok(it, JSON.stringify(plan.skips));
  assert.equal(it.sender, 'Sender C');
  assert.match(it.text, /Hi, this is Kabir from Rankkking\. I will be writing to you from this number from now on\./);
  assert.equal(karan.id, it.id);
});

test('inbox: every number, replies with quotes, images, media fetch', async () => {
  const chats = await api('GET', '/api/chats?instance=all');
  assert.ok(chats.some(c => c.instance === 'wa-reader'), 'the reader shows its chats too');
  assert.ok(new Set(chats.map(c => c.instance)).size >= 3);
  const g1 = await api('GET', `/api/chats/wa-reader/${encodeURIComponent(G.g1)}`);
  const theirs = g1.messages.find(m => !m.fromMe && !m.ours);
  assert.ok(theirs.sender, 'sender name shown in groups');
  await api('POST', `/api/chats/wa-senderb/${encodeURIComponent(G.g2)}/send`, { text: 'Replying to you', quotedId: theirs.id });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await api('POST', `/api/chats/wa-senderb/${encodeURIComponent(G.g2)}/send-media`, { mediatype: 'image', mimetype: 'image/png', base64: png, caption: 'rate card', fileName: 'card.png' });
  const t = await api('GET', `/api/chats/wa-senderb/${encodeURIComponent(G.g2)}`);
  const img = t.messages[t.messages.length - 1];
  assert.equal(img.media.kind, 'image');
  assert.equal(img.text, 'rate card');
  const res = await api('GET', `/api/media/wa-senderb/${img.id}`, undefined, { raw: true });
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // 2: the reader never sends anything, not even by hand.
  await assert.rejects(api('POST', `/api/chats/wa-reader/${encodeURIComponent(G.g1)}/send`, { text: 'x' }), /reader number/);
  // A disconnected number cannot send.
  await assert.rejects(api('POST', `/api/chats/wa-sendera/${encodeURIComponent(G.g1)}/send`, { text: 'x' }), /not connected/);
  await assert.rejects(api('POST', `/api/chats/wa-senderb/not-a-jid/send`, { text: 'x' }), /bad chat id/);
});

test('exports and the event log', async () => {
  const res = await api('GET', '/api/export/resellers.csv', undefined, { raw: true });
  const csv = await res.text();
  assert.match(csv.split('\n')[0], /code,name,phone/);
  assert.equal(csv.trim().split('\n').length, 7);
  const groups = await (await api('GET', '/api/export/groups.csv', undefined, { raw: true })).text();
  assert.match(groups, /Prime view - 01 Wire/);
  const ev = await api('GET', '/api/events?limit=500');
  for (const k of ['number.add', 'leads.import', 'reseller.call', 'reseller.bind', 'run.approve', 'send.ok', 'run.done', 'reseller.reply']) {
    assert.ok(ev.some(e => e.kind === k), `event ${k} is logged`);
  }
});
