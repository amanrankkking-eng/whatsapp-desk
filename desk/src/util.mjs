// Small shared helpers: the clock, IST dates, phone numbers, CSV, and message text.
import { cfg } from './config.mjs';

// ---------------------------------------------------------------- clock
// A movable clock so tests can walk through days. Only test mode can move it.
let offsetMs = 0;
export const now = () => new Date(Date.now() + offsetMs);
export const nowSec = () => Math.floor(now().getTime() / 1000);
export function setClock(iso) {
  if (!cfg.test) throw new Error('the clock can only be moved in test mode');
  offsetMs = new Date(iso).getTime() - Date.now();
}
export function advanceClock(ms) {
  if (!cfg.test) throw new Error('the clock can only be moved in test mode');
  offsetMs += ms;
}

// ---------------------------------------------------------------- IST dates
const TZ = 'Asia/Kolkata';
const IST_OFFSET_MIN = 330;
export const istDate = (d = now()) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
export const istWeekday = (d = now()) => new Date(d).toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ });
export function istMinutes(d = now()) {
  const t = new Date(new Date(d).getTime() + IST_OFFSET_MIN * 60000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
// UTC Date for an IST wall-clock time on an IST date ("2026-09-28", "10:30").
export function istToUtc(dateStr, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - IST_OFFSET_MIN * 60000);
}
export const hhmmToMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
export const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
export const daysSinceSec = ts => (ts == null ? null : Math.floor((nowSec() - Number(ts)) / 86400));
export function addIstDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + n);
  return istDate(d);
}

// ---------------------------------------------------------------- phones
// One shape for every phone number: digits only, with country code. Indian 10-digit
// mobiles get 91. Anything that cannot be a WhatsApp number is rejected with a reason.
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'empty number' };
  if (/[a-z]/i.test(s.replace(/^tel:/i, ''))) return { ok: false, reason: 'contains letters' };
  const hadPlus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!hadPlus) {
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) {
      if (!/^[6-9]/.test(d)) return { ok: false, reason: 'not an Indian mobile number (10 digits must start with 6-9)' };
      d = `91${d}`;
    }
  }
  if (d.startsWith('91') && d.length !== 12) return { ok: false, reason: `Indian number with ${d.length - 2} digits after 91` };
  if (d.startsWith('91') && !/^91[6-9]/.test(d)) return { ok: false, reason: 'not an Indian mobile number' };
  if (d.length < 8 || d.length > 15) return { ok: false, reason: `${d.length} digits is not a phone number` };
  return { ok: true, phone: d };
}
export const phoneOfJid = jid => (jid && /@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0].split(':')[0] : null);
export const digitsOf = jid => String(jid || '').split('@')[0].split(':')[0];

// ---------------------------------------------------------------- CSV
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------- message text
// Friendly names for message kinds that carry no text of their own.
const KIND_LABEL = { imageMessage: '[image]', videoMessage: '[video]', audioMessage: '[voice note]', documentMessage: '[document]',
  stickerMessage: '[sticker]', albumMessage: '[album]', placeholderMessage: '[message not available yet]', liveLocationMessage: '[live location]',
  locationMessage: '[location]', contactMessage: '[contact]', sendPaymentMessage: '[payment]', groupInviteMessage: '[group invite]',
  statusMentionMessage: '[status mention]', interactiveMessage: '[interactive message]', secretEncryptedMessage: '[message]', unknown: '[message]' };
export function textOf(message, type) {
  // A message edited to nothing or removed keeps its row with an empty body.
  if (!message || typeof message !== 'object') return KIND_LABEL[type] || (type ? '[message]' : '');
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  for (const k of ['imageMessage', 'videoMessage', 'documentMessage']) {
    if (message[k]) return message[k].caption ? `[${k.replace('Message', '')}] ${message[k].caption}` : `[${k.replace('Message', '')}]`;
  }
  const dwc = message.documentWithCaptionMessage?.message?.documentMessage;
  if (dwc) return dwc.caption ? `[document] ${dwc.caption}` : '[document]';
  if (message.audioMessage) return '[voice note]';
  if (message.stickerMessage) return '[sticker]';
  const t = message.templateMessage?.hydratedTemplate || message.templateMessage?.hydratedFourRowTemplate;
  if (t) return t.hydratedContentText || t.hydratedTitleText || '[template]';
  if (message.buttonsResponseMessage) return message.buttonsResponseMessage.selectedDisplayText || '[button reply]';
  if (message.listResponseMessage) return message.listResponseMessage.title || '[list reply]';
  if (message.templateButtonReplyMessage) return message.templateButtonReplyMessage.selectedDisplayText || '[button reply]';
  if (message.interactiveMessage?.body?.text) return message.interactiveMessage.body.text;
  if (message.groupInviteMessage) return `[group invite] ${message.groupInviteMessage.groupName || ''}`.trim();
  if (message.contactMessage) return `[contact] ${message.contactMessage.displayName || ''}`.trim();
  if (message.locationMessage) return '[location]';
  const poll = message.pollCreationMessage || message.pollCreationMessageV3;
  if (poll) return `[poll] ${poll.name || ''}`.trim();
  return KIND_LABEL[type] || '[message]';
}
// Text shown inside a bubble: the caption for media, the text otherwise.
export function bodyText(message, type) {
  if (!message || typeof message !== 'object') return '';
  const doc = message.documentWithCaptionMessage?.message?.documentMessage;
  for (const m of [message.imageMessage, message.videoMessage, message.documentMessage, doc]) if (m) return m.caption || '';
  if (message.audioMessage || message.stickerMessage) return '';
  return textOf(message, type);
}
export function mediaInfo(message) {
  if (!message || typeof message !== 'object') return {};
  const doc = message.documentMessage || message.documentWithCaptionMessage?.message?.documentMessage;
  const m = message.imageMessage || message.videoMessage || message.stickerMessage || message.audioMessage || doc;
  if (!m) return {};
  const kind = message.imageMessage ? 'image' : message.videoMessage ? 'video' : message.stickerMessage ? 'sticker'
    : message.audioMessage ? 'audio' : 'document';
  return { media: { kind, mimetype: m.mimetype || null, fileName: m.fileName || null, seconds: m.seconds || null,
    size: Number(m.fileLength?.low ?? m.fileLength) || null,
    thumb: typeof m.jpegThumbnail === 'string' && m.jpegThumbnail.length < 60000 ? m.jpegThumbnail : null } };
}
// Plain text in SQL, without pulling media payloads.
export const TEXT_SQL = `coalesce(message->>'conversation', message->'extendedTextMessage'->>'text',
  message->'imageMessage'->>'caption', message->'videoMessage'->>'caption', message->'documentMessage'->>'caption',
  message->'documentWithCaptionMessage'->'message'->'documentMessage'->>'caption',
  message->'templateMessage'->'hydratedTemplate'->>'hydratedContentText', '')`;
export const typeLabel = (type, txt) => txt || ({ imageMessage: '[image]', videoMessage: '[video]', audioMessage: '[voice note]',
  documentMessage: '[document]', stickerMessage: '[sticker]' }[type] || `[${type}]`);

// ---------------------------------------------------------------- reading a reseller's words
// Opt-out words (from the reseller flow's poll.py). Loose on purpose: a hit marks the row
// do-not-contact and alerts the owner, who can undo it.
const STOP_WORDS = ['stop', 'stop it', 'please stop', 'stop messaging', 'stop sending', 'unsubscribe', 'opt out', 'optout',
  'remove me', 'remove my number', 'remove this number', "don't message", 'dont message', 'do not message',
  "don't message me", 'dont message me', 'do not message me', "don't send", 'dont send', 'do not send', 'no more messages',
  'band karo', 'band kar do', 'bandh karo', 'band kardo', 'mat bhejo', 'mat bhejiye', 'mat bheje', 'na bhejo',
  'message mat karo', 'msg mat karo', 'bhejna band'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const STOP_RE = new RegExp(`\\b(?:${STOP_WORDS.map(esc).join('|')})\\b`, 'i');

// Buying signal: asked the price, the catalogue or the packages, or talked about an order.
const PRICE_ASK = /\b(price|prices|pricing|cost|costs|rate|rates|rate ?card|charge|charges|quote|quotation|budget|discount|how much|kitna|kitne|kya rate|fee|fees|per article|per release|usd|inr|rs)\b|₹|\$\s?\d/i;
const CATALOGUE_ASK = /\b(catalog|catalogue|package|packages|plans?|media ?list|site ?list|publications?|outlets?|portfolio|samples?|options)\b/i;
const ORDER_TALK = /\b(order|orders|booking|book it|book this|confirm|confirmed|payment|paid|pay|invoice|advance|go ahead|proceed|publish this|publish it|send the link|live link)\b/i;
const DOMAIN_NOISE = /https?:\/\/\S+|\b(?:docs\.google|drive\.google|meet\.google|google|gmail|whatsapp|wa\.me|youtube|youtu\.be|zoom)\.[a-z.]+/gi;
export function buyingSignal(text) {
  const t = String(text || '').replace(DOMAIN_NOISE, ' ');
  if (PRICE_ASK.test(t)) return 'asked the price';
  if (CATALOGUE_ASK.test(t)) return 'asked for the catalogue or packages';
  if (ORDER_TALK.test(t)) return 'talked about an order';
  return null;
}

// ---------------------------------------------------------------- misc
export function randomGapSec(min, max) {
  // 5m01s-14m00s by default; a whole-minute gap is thrown away and drawn again.
  let g;
  do { g = Math.round(min + Math.random() * (max - min)); } while (g % 60 === 0 && max - min > 60);
  return g;
}
export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
export const squash = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const clampInt = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
