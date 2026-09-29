// Ad leads: every one-to-one chat on a number that started from a Click-to-WhatsApp ad
// (Instagram, Facebook or WhatsApp), with the ad, the first message, whether we answered, and
// where it stands now. Everything else lands in "others", so no contact is left out.
// Used by tools/ad-leads.mjs (CSV / Google Sheet) and by the MCP tool ad_leads. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { q } from './db.mjs';

// Where Evolution keeps each number's session files (the LID-to-phone mappings live there).
// On the Mac: ~/Claude/evolution-local/app/instances. In Docker: the evolution_instances volume.
export function instancesDir() {
  if (process.env.EVOLUTION_INSTANCES_DIR) return process.env.EVOLUTION_INSTANCES_DIR;
  const evoDir = process.env.LOCAL_EVOLUTION_DIR || path.join(process.env.HOME || '', 'Claude/evolution-local');
  return path.join(evoDir, 'app', 'instances');
}

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
export function lidPhoneMap() {
  const map = new Map();
  const root = instancesDir();
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

export async function adLeads(instance) {
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
    oldest: rows.length ? fmt(Math.min(...rows.map(r => Number(r.ts)))) : '', newest: rows.length ? fmt(Math.max(...rows.map(r => Number(r.ts)))) : '', leads, others };
  return out;
}
