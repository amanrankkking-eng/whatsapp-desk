// Lists every chat on one number that started from a Click-to-WhatsApp ad (Instagram or Facebook),
// with the ad, the first message, whether we answered, and where the conversation stands now.
//
//   node tools/ad-leads.mjs --instance wa-8373978883 [--csv out.csv] [--json out.json]
//
// Reads only: the database (Evolution's messages and contacts) and the LID-to-phone mapping files
// Evolution keeps per number. It sends nothing to WhatsApp.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { cfg } from '../src/config.mjs';

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const instance = arg('instance');
if (!instance) { console.error('usage: node tools/ad-leads.mjs --instance <evolution instance name>'); process.exit(1); }
const evoDir = process.env.LOCAL_EVOLUTION_DIR || path.join(process.env.HOME || '', 'Claude/evolution-local');

const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

// The text a person typed, or a label for anything else.
function textOf(m) {
  const msg = m.message || {};
  const t = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption
    || msg.documentMessage?.caption || msg.documentWithCaptionMessage?.message?.documentMessage?.caption;
  if (t) return t;
  const kind = { imageMessage: '[image]', videoMessage: '[video]', audioMessage: '[voice note]', documentMessage: '[document]',
    stickerMessage: '[sticker]', contactMessage: '[contact]', locationMessage: '[location]' }[m.messageType];
  return kind || `[${m.messageType}]`;
}
// Ad details from WhatsApp's own attribution on the message (Click-to-WhatsApp).
function adOf(m) {
  const msg = m.message || {};
  const inner = msg.extendedTextMessage?.contextInfo || msg.imageMessage?.contextInfo || msg.videoMessage?.contextInfo || null;
  const ctx = m.contextInfo || inner || {};
  const ad = ctx.externalAdReply || inner?.externalAdReply || null;
  if (ad && (ad.sourceType === 'ad' || ad.sourceId || ad.ctwaClid)) return ad;
  if (ctx.conversionSource || ctx.entryPointConversionSource) return { sourceType: ctx.entryPointConversionSource || ctx.conversionSource };
  return null;
}
// WhatsApp's default text for "Send message" buttons on ads. A chat that opens with it and has no
// attribution is listed as a likely ad lead.
const PREFILLED = [/^hello!? can i get more info on this\??$/i, /^hi!? can i get more info on this\??$/i, /^can i get more info on this\??$/i,
  /^i('| a)m interested/i, /^i want to know more/i, /^more info/i];
// A lead who says in words that they came from the ad ("maine abhi aapka ad dekha", "saw your ad").
const MENTIONS_AD = /\b(aapka|apka|aap ka|your|ur|the|this|tumhara)\s+(ad|ads|advert|advertisement)\b|\b(ad|ads)\s+(dekha|dekhi|dekhkar|dekh ke|saw|seen)\b|\bsaw\s+(your|the|an)\s+ad\b/i;

// Every number's mapping files are merged: a user's LID is the same whoever they talk to.
function lidPhoneMap() {
  const map = new Map();
  const root = path.join(evoDir, 'app', 'instances');
  if (!fs.existsSync(root)) return map;
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      const m = f.match(/^lid-mapping-(\d+)_reverse\.json$/);
      if (!m) continue;
      try { const pn = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if (/^\d{8,15}$/.test(String(pn))) map.set(m[1], String(pn)); } catch {}
    }
  }
  return map;
}

const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmt = ts => (ts ? IST.format(new Date(ts * 1000)) : '');

async function main() {
  const inst = (await q(`select id, name, "ownerJid" from evolution_api."Instance" where name = $1`, [instance]))[0];
  if (!inst) throw new Error(`No Evolution instance called ${instance}`);
  const rows = await q(`select distinct on (key->>'remoteJid', key->>'id', key->>'fromMe') key, "pushName", "messageType", message, "contextInfo", "messageTimestamp"::bigint ts
    from evolution_api."Message" where "instanceId" = $1 and key->>'remoteJid' not like '%@g.us'
      and key->>'remoteJid' not like '%@broadcast' and key->>'remoteJid' not like '%@newsletter'
      and "messageType" not in ('protocolMessage','reactionMessage','senderKeyDistributionMessage','messageContextInfo','pollUpdateMessage','editedMessage')
    order by key->>'remoteJid', key->>'id', key->>'fromMe', ("contextInfo" ? 'externalAdReply') desc, ("contextInfo" is null), "messageTimestamp"`, [inst.id]);
  // A message can be stored twice (history sync and live); the copy with the ad attribution is kept.
  // The lead's first message and WhatsApp's ad card share one id, so the direction is part of the key.
  const contacts = new Map((await q(`select "remoteJid", "pushName" from evolution_api."Contact" where "instanceId" = $1`, [inst.id]))
    .map(c => [c.remoteJid, c.pushName]));
  const lidMap = lidPhoneMap();
  for (const r of await q(`select lid, phone from desk.lid_map`).catch(() => [])) if (!lidMap.has(r.lid.split('@')[0])) lidMap.set(r.lid.split('@')[0], r.phone);

  const chats = new Map();
  for (const r of rows) {
    const jid = r.key.remoteJid;
    (chats.get(jid) || chats.set(jid, []).get(jid)).push({ ...r, ts: Number(r.ts), fromMe: !!r.key.fromMe });
  }
  const now = Date.now() / 1000;
  const leads = [], others = [];
  for (const [jid, list] of chats) {
    list.sort((a, b) => a.ts - b.ts);
    const theirs = list.filter(m => !m.fromMe), ours = list.filter(m => m.fromMe);
    if (!theirs.length && !ours.some(m => adOf(m))) continue;
    // The lead's own message usually carries the ad; when it did not reach this device, WhatsApp's
    // ad card on our side of the chat still does.
    const adMsg = theirs.find(m => adOf(m)) || ours.find(m => adOf(m));
    const firstIn = theirs[0] || null;
    const mentions = !adMsg && theirs.find(m => MENTIONS_AD.test(textOf(m)));
    const likely = !adMsg && !mentions && firstIn && PREFILLED.some(re => re.test(textOf(firstIn).trim()));
    const kind = adMsg ? 'ad' : mentions ? 'mentions' : likely ? 'likely' : 'other';
    const ad = adMsg ? adOf(adMsg) : {};
    const start = (adMsg && !adMsg.fromMe ? adMsg : null) || firstIn || adMsg || list[0];
    const user = jid.split('@')[0];
    const phone = jid.endsWith('@s.whatsapp.net') ? user
      : list.map(m => m.key.remoteJidAlt).find(x => x && x.endsWith('@s.whatsapp.net'))?.split('@')[0] || lidMap.get(user) || '';
    const names = [contacts.get(jid), phone && contacts.get(`${phone}@s.whatsapp.net`), ...theirs.map(m => m.pushName)]
      .filter(n => n && !/^\d+$/.test(n));
    // When WhatsApp gives no name, the name our side used in the chat ("Thanks, Kaushik!").
    // The name must end the phrase ("Thanks, Kaushik!"), so "Got it, Telangana news" is not a name.
    const NAME_RE = /\b(?:Thanks|Thank you|Got it|Great|Perfect|Nice to meet you|Welcome|Hi|Hello)[,!]?\s+([A-Z][a-z]{2,20})(?=[!.,?])/;
    const NOT_NAMES = new Set(['There', 'Sir', 'Madam', 'Team', 'Please', 'Happy', 'Thanks', 'Just', 'Sure', 'Again']);
    const chatName = ours.map(m => textOf(m).match(NAME_RE)?.[1]).find(n => n && !NOT_NAMES.has(n)) || '';
    const reply = ours.find(m => m.ts >= start.ts);
    const last = list[list.length - 1];
    let status;
    if (!theirs.length) status = 'Their messages are not on this device';
    else if (!reply) status = 'Never answered by us';
    else if (last.fromMe) status = theirs.some(m => m.ts > reply.ts) ? 'Talked; they went quiet after our last message' : 'We replied; no answer from them';
    else status = 'They wrote last; waiting on us';
    const lead = {
      kind, name: names[0] || '', chat_name: chatName, phone, chat: jid,
      source: ad.sourceApp ? `${ad.sourceApp[0].toUpperCase()}${ad.sourceApp.slice(1)} ad` : adMsg ? 'Ad'
        : kind === 'mentions' ? 'Likely ad (says they saw the ad)' : kind === 'likely' ? 'Likely ad (prefilled text)' : 'No ad data',
      ad_id: ad.sourceId || '', ad_link: ad.sourceUrl || '', ad_text: String(ad.body || ad.title || '').replace(/\s+/g, ' ').slice(0, 200),
      first_at: fmt(start.ts), first_text: (start.fromMe ? '(their first message is not on this device) ' : '') + textOf(start).slice(0, 300),
      our_first_reply: reply ? fmt(reply.ts) : 'never',
      their_msgs: theirs.length, our_msgs: ours.length, last_at: fmt(last.ts), last_by: last.fromMe ? 'us' : 'them',
      last_text: textOf(last).slice(0, 300), days_quiet: Math.floor((now - last.ts) / 86400), status, first_ts: start.ts,
    };
    (kind === 'other' ? others : leads).push(lead);
  }
  leads.sort((a, b) => b.first_ts - a.first_ts);
  others.sort((a, b) => b.first_ts - a.first_ts);
  const out = { instance, number: (inst.ownerJid || '').split('@')[0], generated: new Date().toISOString(), messages: rows.length, chats: chats.size,
    oldest: fmt(Math.min(...rows.map(r => Number(r.ts)))), newest: fmt(Math.max(...rows.map(r => Number(r.ts)))), leads, others };
  const json = arg('json'), csv = arg('csv');
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 1));
  if (csv) {
    const cols = Object.keys(leads[0] || { name: '' }).filter(c => c !== 'first_ts');
    const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, '﻿' + [cols.join(','), ...leads.map(l => cols.map(c => cell(l[c])).join(','))].join('\n'));
  }
  const by = k => leads.reduce((a, l) => ((a[l[k]] = (a[l[k]] || 0) + 1), a), {});
  const sheet = arg('sheet');
  if (sheet) out.sheetUrl = await pushSheet(sheet, out, by);
  console.log(JSON.stringify({ instance, messages: rows.length, chats: chats.size, oldest: out.oldest, newest: out.newest, leads: leads.length,
    with_phone: leads.filter(l => l.phone).length, others: others.length, others_with_phone: others.filter(l => l.phone).length, by_source: by('source'), by_status: by('status'), by_ad: by('ad_id'), sheet: out.sheetUrl || null }, null, 1));
  await pool.end();
}
// ---------------------------------------------------------------- Google Sheet (through the Composio CLI)
// --sheet new      creates a spreadsheet in the amanrankkking@gmail.com Drive
// --sheet <id>     rewrites the Leads and Summary tabs of an existing one (the Notes columns are kept)
import { execFileSync } from 'node:child_process';
import os from 'node:os';
const ACCOUNT = process.env.SHEETS_ACCOUNT || 'googlesheets_funnel-logion';   // amanrankkking@gmail.com
function composio(slug, params) {
  const tmp = path.join(os.tmpdir(), `adleads-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(params));
  let last = '';
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      let out = '';
      try {
        out = execFileSync(process.env.COMPOSIO_BIN || path.join(os.homedir(), '.local/bin/composio'),
          ['execute', slug, '-d', `@${tmp}`, '--account', ACCOUNT],
          { env: { ...process.env, COMPOSIO_SECURITY: 'allow' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 });
      } catch (e) { out = String(e.stdout || ''); last = String(e.stderr || e.message).slice(-300); }
      const i = out.indexOf('{');
      let env = null; try { env = i >= 0 ? JSON.parse(out.slice(i)) : null; } catch {}
      if (env?.storedInFile && env.outputFilePath) env = JSON.parse(fs.readFileSync(env.outputFilePath, 'utf8'));
      if (env?.successful) return env.data || {};
      last = JSON.stringify(env || out).slice(0, 400);
      if (!/denied by user|timeout|ECONN|429|503/i.test(last)) break;   // the approval gate is flaky: wait and retry
      execFileSync('sleep', ['20']);
    }
  } finally { fs.rmSync(tmp, { force: true }); }
  throw new Error(`${slug} failed: ${last}`);
}
async function pushSheet(target, out, by) {
  let id = target;
  if (target === 'new') {
    const d = composio('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', { title: `Ad leads - WhatsApp ${out.number} (${new Date().toISOString().slice(0, 10)})` });
    id = d.spreadsheetId || d.spreadsheet_id || d.response_data?.spreadsheetId;
    if (!id) throw new Error(`create returned no id: ${JSON.stringify(d).slice(0, 300)}`);
    composio('GOOGLESHEETS_UPDATE_SHEET_PROPERTIES', { spreadsheetId: id,
      updateSheetProperties: { properties: { sheetId: 0, title: 'Leads', gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } });
    composio('GOOGLESHEETS_ADD_SHEET', { spreadsheet_id: id, title: 'Summary', force_unique: false });
  }
  // Keep whatever the person typed in the two note columns, matched by chat id.
  const notes = new Map();
  try {
    const d = composio('GOOGLESHEETS_BATCH_GET', { spreadsheet_id: id, ranges: ['Leads!A1:Z2000'] });
    const vals = d.valueRanges?.[0]?.values || [];
    const h = vals[0] || [];
    const ci = h.indexOf('WhatsApp chat id'), fi = h.indexOf('Followed up?'), ni = h.indexOf('Notes');
    for (const r of vals.slice(1)) if (r[ci]) notes.set(r[ci], [r[fi] || '', r[ni] || '']);
  } catch {}
  const header = ['#', 'Lead name', 'Name used in chat', 'Phone', 'Came from', 'First message (IST)', 'First message', 'Our first reply (IST)', 'Their msgs', 'Our msgs',
    'Last message (IST)', 'Last by', 'Last message', 'Days since last', 'Status', 'Ad id', 'Ad post', 'Ad text', 'WhatsApp chat id',
    'Open in desk (this Mac)', 'Followed up?', 'Notes'];
  const rows = out.leads.map((l, i) => [i + 1, l.name, l.chat_name, l.phone ? `+${l.phone}` : '(hidden by WhatsApp)', l.source, l.first_at, l.first_text, l.our_first_reply,
    l.their_msgs, l.our_msgs, l.last_at, l.last_by, l.last_text, l.days_quiet, l.status, l.ad_id, l.ad_link, l.ad_text, l.chat,
    `http://localhost:8092/#/chats/${encodeURIComponent(out.instance)}/${encodeURIComponent(l.chat)}`, ...(notes.get(l.chat) || ['', ''])]);
  composio('GOOGLESHEETS_CLEAR_VALUES', { spreadsheet_id: id, range: 'Leads!A1:Z2000' });
  composio('GOOGLESHEETS_VALUES_UPDATE', { spreadsheet_id: id, range: 'Leads!A1', value_input_option: 'RAW', values: [header, ...rows] });
  // Every other one-to-one chat on the number, so no contact is left out of the sheet.
  try { composio('GOOGLESHEETS_ADD_SHEET', { spreadsheet_id: id, title: 'Other chats', force_unique: false }); } catch {}
  const otherRows = out.others.map((l, i) => [i + 1, l.name, l.chat_name, l.phone ? `+${l.phone}` : '(hidden by WhatsApp)', l.source, l.first_at, l.first_text,
    l.our_first_reply, l.their_msgs, l.our_msgs, l.last_at, l.last_by, l.last_text, l.days_quiet, l.status, '', '', '', l.chat,
    `http://localhost:8092/#/chats/${encodeURIComponent(out.instance)}/${encodeURIComponent(l.chat)}`]);
  composio('GOOGLESHEETS_CLEAR_VALUES', { spreadsheet_id: id, range: 'Other chats!A1:Z2000' });
  composio('GOOGLESHEETS_VALUES_UPDATE', { spreadsheet_id: id, range: 'Other chats!A1', value_input_option: 'RAW', values: [header.slice(0, 20), ...otherRows] });
  const summary = [
    ['Ad leads on WhatsApp', `+${out.number}`], ['Refreshed', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })],
    ['Messages read', out.messages], ['Chats read', out.chats], ['Messages cover', `${out.oldest} to ${out.newest}`],
    ['Leads from ads', out.leads.length], ['Leads with a phone number', out.leads.filter(l => l.phone).length],
    ['Other one-to-one chats (tab "Other chats")', out.others.length], [],
    ['Came from', 'Leads'], ...Object.entries(by('source')), [], ['Status', 'Leads'], ...Object.entries(by('status')), [],
    ['How a lead is found', 'The lead\'s first message carries WhatsApp\'s own ad attribution (the ad id, the post and the app), or it opens with WhatsApp\'s default ad text such as "Hello! Can I get more info on this?" (marked "Likely ad").'],
    ['Phone numbers', 'WhatsApp now hides many numbers behind a private id (LID). A number shows here once WhatsApp shares it with the linked device; until then open the chat from the desk link.'],
  ];
  composio('GOOGLESHEETS_CLEAR_VALUES', { spreadsheet_id: id, range: 'Summary!A1:D200' });
  composio('GOOGLESHEETS_VALUES_UPDATE', { spreadsheet_id: id, range: 'Summary!A1', value_input_option: 'RAW', values: summary.map(r => r.map(v => (v == null ? '' : v))) });
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

main().catch(e => { console.error(e.message); process.exit(1); });
