// A self-contained demo: a throwaway database, the mock Evolution API and the desk, filled with
// four numbers, resellers, groups, long chats, replies, a run with receipts, and open alerts.
// For trying the dashboard in a browser without touching WhatsApp.
//
//   node test/demo.mjs            then open http://localhost:8093  (user demo / demo-pass-1)
//
// Stop it with Ctrl+C. Nothing here reaches WhatsApp or Google.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startMockEvolution } from './mock-evolution.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8093, MOCK_PORT = Number(process.env.MOCK_PORT) || 18081, KEY = 'demo-evolution-key';
const USER = 'demo', PASS = 'demo-pass-1';

function adminUrl() {
  if (process.env.TEST_ADMIN_DB_URL) return process.env.TEST_ADMIN_DB_URL;
  const pw = fs.readFileSync(path.join(process.env.HOME, 'Claude/evolution-local/.pgpass.env'), 'utf8').match(/PG_PASSWORD=(.*)/)[1].trim().replace(/^['"]|['"]$/g, '');
  return `postgresql://evolution:${encodeURIComponent(pw)}@127.0.0.1:5433/evolution`;
}
const dbUrl = (() => { const u = new URL(adminUrl()); u.pathname = '/desk_demo'; return u.toString(); })();

const admin = new pg.Client({ connectionString: adminUrl() });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = 'desk_demo' and pid <> pg_backend_pid()`);
await admin.query('drop database if exists desk_demo');
await admin.query('create database desk_demo');
await admin.end();
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query(fs.readFileSync(path.join(HERE, 'evolution-schema.sql'), 'utf8'));
await db.end();

const mock = await startMockEvolution({ port: MOCK_PORT, databaseUrl: dbUrl, apiKey: KEY });
const desk = spawn(process.execPath, [path.join(HERE, '..', 'src', 'server.mjs')], {
  env: { ...process.env, DATABASE_URL: dbUrl, EVO_URL: mock.url, EVO_API_KEY: KEY, PORT: String(PORT), HOST: '127.0.0.1', DESK_TEST: '1',
    DESK_WORKERS: '1', DESK_USER: USER, DESK_PASSWORD: PASS, TEST_CHAT_SINK: `${mock.url}/chat-sink` },
  stdio: 'inherit',
});
const stop = () => { desk.kill('SIGTERM'); mock.close().finally(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

let cookie = '';
const base = `http://127.0.0.1:${PORT}`;
async function api(method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-desk': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p}: ${d?.error}`);
  return d;
}
const mockCall = (p, body) => fetch(`${mock.url}/mock/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const at = async ms => mockCall('clock', { iso: new Date(ms).toISOString() });
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await sleep(150); }
await api('POST', '/api/login', { user: USER, password: PASS });

const P = { reader: '919000000100', a: '919000000101', b: '919000000102', c: '919000000103', aman: '919000000200' };
const DAY = 86400000, now = Date.now();
await at(now - 40 * DAY);
for (const [label, role, phone, name] of [['Reader', 'reader', P.reader, 'Rankkking Desk'], ['Sender A', 'sender', P.a, 'Priya'],
  ['Sender B', 'sender', P.b, 'Neha'], ['Sender C', 'sender', P.c, 'Kabir']]) {
  const r = await api('POST', '/api/numbers', { label, role });
  await mockCall('link', { instance: r.instance, phone, name });
  await api('GET', `/api/numbers/${r.instance}/link`);
  if (role === 'sender') await api('PATCH', `/api/numbers/${r.instance}`, { warmed: true });
}
await api('PUT', '/api/settings', { team_numbers: { [P.aman]: 'Aman' }, team_chat_webhook: 'https://chat.googleapis.com/v1/spaces/DEMO/messages?key=k&token=t' });
await api('POST', '/api/owners', { name: 'Roshan', phone: '9000000300' });
await api('POST', '/api/owners', { name: 'Aman', phone: '9000000200' });

const people = [
  ['Ravi Kumar', '9811111101', 'Ravi PR', 'Delhi', 'Roshan', 'a'], ['Sunita Sharma', '9811111102', 'SK Media', 'Pune', 'Roshan', 'b'],
  ['Karan Mehta', '9811111103', 'KP Comms', 'Mumbai', 'Aman', 'a'], ['Meena Joshi', '9811111104', 'MJ Digital', 'Jaipur', 'Roshan', 'c'],
  ['Deepak Rao', '9811111106', 'Rao PR', 'Noida', 'Aman', 'c'], ['Farhan Ali', '9811111107', 'FA Media', 'Lucknow', 'Roshan', 'b'],
  ['Neelam Gupta', '9811111108', 'NG Stories', 'Indore', 'Aman', 'a'], ['Vikram Singh', '9811111109', 'VS Brand', 'Chandigarh', 'Roshan', 'b'],
];
const csv = 'Name,Phone,Company,City,Owner\n' + people.map(p => p.slice(0, 5).join(',')).join('\n') + '\nBad Row,12345,,,\nRavi dup,98111 11101,,,';
await api('POST', '/api/resellers/import', { csv, source: 'Ankush sheet' });
const rows = await api('GET', '/api/resellers');
for (const [i, p] of people.entries()) {
  const r = rows.find(x => x.phone === `91${p[1]}`);
  await api('POST', `/api/resellers/${r.id}/call`, { call: 1, outcome: 'Interested' });
  const jid = `1203630000000001${String(i).padStart(2, '0')}@g.us`;
  await mockCall('group', { jid, subject: `${r.code} ${p[0].split(' ')[0]} x Rankkking`, members: [P.reader, P[p[5]], P.aman, `91${p[1]}`] });
  const inst = { a: 'wa-sendera', b: 'wa-senderb', c: 'wa-senderc' }[p[5]];
  await at(now - (30 - i) * DAY);
  await api('POST', `/api/chats/${inst}/${encodeURIComponent(jid)}/send`, { text: `Hi ${p[0].split(' ')[0]}, this is our first offer: *Yahoo Finance + 250 sites* for $125, live in 12-24 hrs.` });
  if (i !== 4) await api('POST', `/api/resellers/${r.id}/call`, { call: 2, outcome: i === 3 ? 'Call back later' : 'Interested' });
}
// A long conversation in Ravi's group, to try scrolling.
const g0 = '120363000000000100@g.us';
for (let k = 0; k < 160; k++) {
  await at(now - 29 * DAY + k * 3600000);
  const fromUs = k % 3 === 0;
  await mockCall('message', { jid: g0, from: fromUs ? P.a : k % 7 === 0 ? P.aman : '919811111101',
    text: fromUs ? `Update ${k}: your release for client ${k} is live. Link: https://example.com/r/${k}` : k % 5 === 0 ? `Can you share the price list for next week? (${k})` : `Noted, thanks (${k}).\nSecond line of the message.` });
}
// Karan asked the price and nobody answered yet: this becomes an open alert.
await at(now - 2 * 3600000);
await mockCall('message', { jid: '120363000000000102@g.us', from: '919811111103', text: 'What is the rate for Business Insider this week?' });
// Sunita typed several messages in a row.
await at(now - 50 * 60000);
for (const t of ['Hello', 'Are you there?', 'I have 3 releases for this week', 'Please share the packages']) await mockCall('message', { jid: '120363000000000101@g.us', from: '919811111102', text: t });
// Farhan asked to stop.
await at(now - 20 * 60000);
await mockCall('message', { jid: '120363000000000105@g.us', from: '919811111107', text: 'Please stop sending these messages' });
// A group with two senders (cannot bind) and one with no reseller.
await mockCall('group', { jid: '120363000000000190@g.us', subject: 'New client - two senders', members: [P.reader, P.a, P.b, '919822222201'] });
await mockCall('group', { jid: '120363000000000191@g.us', subject: 'Prime view - 01 Wire', members: [P.reader, P.a, '919822222202'] });
await mockCall('group', { jid: '120363000000000192@g.us', subject: 'Test group', members: [P.reader, P.c] });
// A direct chat.
await mockCall('message', { jid: '919833333301@s.whatsapp.net', from: '919833333301', to: P.a, text: 'Hi, got your number from Ravi. Do you do PR in Dubai?' });
await at(now);
await api('POST', '/api/run-worker/read');
await sleep(400);
console.log(`\n[demo] ready: http://localhost:${PORT}  (user ${USER} / ${PASS})\n`);
