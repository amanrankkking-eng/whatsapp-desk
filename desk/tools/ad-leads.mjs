// Lists every chat on one number that started from a Click-to-WhatsApp ad (Instagram or Facebook),
// with the ad, the first message, whether we answered, and where the conversation stands now.
//
//   node tools/ad-leads.mjs --instance wa-8373978883 [--csv out.csv] [--json out.json] [--sheet new|<spreadsheet id>]
//
// Reads only: the database (Evolution's messages and contacts) and the LID-to-phone mapping files
// Evolution keeps per number. It sends nothing to WhatsApp.
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db.mjs';
import { adLeads } from '../src/adleads.mjs';

const arg = (name, def = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const instance = arg('instance');
if (!instance) { console.error('usage: node tools/ad-leads.mjs --instance <evolution instance name>'); process.exit(1); }

async function main() {
  const out = await adLeads(instance);
  const { leads, others } = out;
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
  console.log(JSON.stringify({ instance, messages: out.messages, chats: out.chats, oldest: out.oldest, newest: out.newest, leads: leads.length,
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
