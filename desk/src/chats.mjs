// The WhatsApp-style inbox: chat lists, threads, replies, media and delivery ticks, per number.
import { q, one } from './db.mjs';
import { evo, connectionState, encodeInstance } from './evo.mjs';
import { textOf, bodyText, mediaInfo, httpError, now, istDate, istToUtc, addIstDays, TEXT_SQL, typeLabel } from './util.mjs';

const RANK = { ERROR: -1, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };
const RANK_NAME = { '-1': 'ERROR', 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ', 5: 'READ' };

// Evolution keeps the send-time status on the message row and writes every later receipt to
// MessageUpdate (groups: one row per member, thanks to the receipts patch). Best of them wins.
async function receiptStats(rowIds, ownIds) {
  if (!rowIds.length) return new Map();
  const rows = await q(`
    with u as (select "messageId" mid, participant,
      case status when 'PLAYED' then 5 when 'READ' then 4 when 'DELIVERY_ACK' then 3 when 'SERVER_ACK' then 2 when 'ERROR' then -1 else 1 end r
      from evolution_api."MessageUpdate" where "messageId" = any($1))
    select mid, max(r) filter (where participant is null) plain_r, max(r) filter (where participant is not null) any_member_r,
      count(distinct split_part(participant, '@', 1)) filter (where participant is not null and r >= 3) delivered,
      count(distinct split_part(participant, '@', 1)) filter (where participant is not null and r >= 4) seen
    from u where participant is null or not (split_part(split_part(participant, '@', 1), ':', 1) = any($2))
    group by mid`, [rowIds, ownIds]);
  return new Map(rows.map(r => [r.mid, r]));
}
function tickStatus(row, stats, isGroup, groupSize) {
  if (!row.from_me) return row.status;
  const st = stats.get(row.row_id) || {};
  let rank = Math.max(RANK[row.status] ?? 1, st.plain_r ?? 0);
  if (isGroup) {
    const others = groupSize > 1 ? groupSize - 1 : null;
    if (st.any_member_r != null) rank = Math.max(rank, RANK.SERVER_ACK);
    if (others ? Number(st.seen) >= others : Number(st.seen) > 0) rank = Math.max(rank, RANK.READ);
    else if (others ? Number(st.delivered) >= others : Number(st.delivered) > 0) rank = Math.max(rank, RANK.DELIVERY_ACK);
  }
  // A stored outgoing message was accepted by Evolution; after a few seconds treat it as sent.
  if (rank === RANK.PENDING && now().getTime() / 1000 - row.ts > 8) rank = RANK.SERVER_ACK;
  return RANK_NAME[rank] || row.status;
}
// The sending number's own ids. Receipts from our other numbers (the reader, say) are real
// deliveries and count like anyone else's.
async function ownIdsByInstance() {
  const rows = await q(`select instance, phone, lid from desk.numbers`);
  return Object.fromEntries(rows.map(r => [r.instance, [r.phone, r.lid && r.lid.split('@')[0]].filter(Boolean)]));
}
async function statsFor(rows, rowIdKey) {
  const own = await ownIdsByInstance();
  const byInst = new Map();
  for (const r of rows) (byInst.get(r.instance) || byInst.set(r.instance, []).get(r.instance)).push(r[rowIdKey]);
  const out = new Map();
  for (const [inst, ids] of byInst) for (const [k, v] of await receiptStats(ids, own[inst] || [])) out.set(k, v);
  return out;
}

export async function listChats(instance) {
  const inst = instance && instance !== 'all' ? instance : null;
  const installed = Number((await one(`select value from desk.meta where key = 'installed_at'`))?.value) || 0;
  const rows = await q(`
    with m as (select instance, jid, from_me, ts, type, message, push_name, status, row_id from desk.msg where ($1::text is null or instance = $1)),
    agg as (select m.instance, m.jid, max(m.ts) last_ts, count(*) filter (where not m.from_me)::int inbound, count(*) filter (where m.from_me)::int outbound,
              count(*) filter (where not m.from_me and m.ts > greatest(coalesce(s.ts, 0), $2))::int unread,
              max(m.push_name) filter (where not m.from_me) any_name
            from m left join desk.chat_seen s on s.instance = m.instance and s.jid = m.jid group by m.instance, m.jid),
    last as (select distinct on (instance, jid) instance, jid, from_me last_from_me, type, message, status, row_id last_row, ts last_msg_ts
              from m order by instance, jid, ts desc, row_id desc)
    select a.*, l.last_from_me, l.type, l.message, l.status last_status, l.last_row, l.last_msg_ts,
      coalesce(g.subject, c.name, nullif(ct."pushName", split_part(a.jid, '@', 1)), nullif(a.any_name, split_part(a.jid, '@', 1)),
        case when lm.phone is not null then '+' || lm.phone end, a.any_name) as name,
      g.size, r.id reseller_id, r.code reseller_code, r.name reseller_name, r.instance reseller_instance, lm.phone lid_phone
    from agg a join last l using (instance, jid)
      left join desk.groups g on g.instance = a.instance and g.jid = a.jid
      left join evolution_api."Instance" i on i.name = a.instance
      left join evolution_api."Chat" c on c."remoteJid" = a.jid and c."instanceId" = i.id
      left join evolution_api."Contact" ct on ct."remoteJid" = a.jid and ct."instanceId" = i.id
      left join desk.resellers r on r.group_jid = a.jid
      left join desk.lid_map lm on lm.lid = a.jid
    order by a.last_ts desc limit 2000`, [inst, installed]);
  const stats = await statsFor(rows.filter(r => r.last_from_me), 'last_row');
  return rows.map(r => ({
    instance: r.instance, jid: r.jid, name: r.name, isGroup: r.jid.endsWith('@g.us'), size: r.size, unread: r.unread,
    phone: r.jid.endsWith('@s.whatsapp.net') ? r.jid.split('@')[0] : r.lid_phone || null,
    lastTs: Number(r.last_ts), inbound: r.inbound, outbound: r.outbound, lastFromMe: r.last_from_me,
    lastStatus: tickStatus({ from_me: r.last_from_me, status: r.last_status, row_id: r.last_row, ts: Number(r.last_msg_ts) }, stats, r.jid.endsWith('@g.us'), r.size),
    lastText: textOf(r.message, r.type).slice(0, 160),
    reseller: r.reseller_code ? { id: r.reseller_id, code: r.reseller_code, name: r.reseller_name, instance: r.reseller_instance } : null,
  }));
}

// Marks a chat as seen on every one of our numbers that is in it. Nothing is sent to WhatsApp.
export async function markSeen(jid, ts) {
  await q(`insert into desk.chat_seen (instance, jid, ts) select n.instance, $1, $2 from desk.numbers n
    on conflict (instance, jid) do update set ts = greatest(desk.chat_seen.ts, excluded.ts)`, [jid, Math.floor(Number(ts) || 0)]);
  return { ok: true };
}

export async function chatMessages(instance, jid, limit) {
  limit = Math.min(Math.max(Number(limit) || 150, 20), 600);
  const rows = await q(`
    with m as (select * from desk.msgx where instance = $1 and jid = $2 order by ts desc, row_id desc limit $3)
    select m.*, coalesce(m.sender_name, ct."pushName") contact_name
    from m left join evolution_api."Instance" i on i.name = m.instance
      left join evolution_api."Contact" ct on ct."instanceId" = i.id and ct."remoteJid" = m.sender_id`, [instance, jid, limit]);
  rows.sort((a, b) => Number(a.ts) - Number(b.ts) || (a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0));
  const g = await one(`select subject, size, announce from desk.groups where instance = $1 and jid = $2`, [instance, jid]);
  const c = await one(`select coalesce(c.name, ct."pushName") name from evolution_api."Chat" c join evolution_api."Instance" i on i.id = c."instanceId"
    left join evolution_api."Contact" ct on ct."remoteJid" = c."remoteJid" and ct."instanceId" = c."instanceId"
    where c."remoteJid" = $2 and i.name = $1 limit 1`, [instance, jid]);
  const reseller = await one(`select id, code, name, stage, paused, pause_reason, track, dnc from desk.resellers where group_jid = $1`, [jid]);
  const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0]
    : jid.endsWith('@lid') ? (await one(`select phone from desk.lid_map where lid = $1`, [jid]))?.phone || null : null;
  const stats = await statsFor(rows.filter(r => r.from_me), 'row_id');
  const isGroup = jid.endsWith('@g.us');
  return {
    instance, jid, phone, name: g?.subject || (c?.name && c.name !== jid.split('@')[0] ? c.name : null) || (phone ? `+${phone}` : jid.split('@')[0]),
    isGroup, size: g?.size ?? null, adminsOnly: !!g?.announce,
    state: await connectionState(instance), reseller,
    messages: rows.map(r => ({
      id: r.id, fromMe: r.from_me, ours: r.ours, ts: Number(r.ts), type: r.type,
      status: tickStatus({ ...r, ts: Number(r.ts) }, stats, isGroup, g?.size),
      sender: r.contact_name || (r.sender_phone ? `+${r.sender_phone}` : (r.sender_id || '').split('@')[0].slice(-6)),
      senderJid: r.sender_id, ...mediaInfo(r.message), text: bodyText(r.message, r.type),
      quoted: r.context?.stanzaId ? { id: r.context.stanzaId, text: textOf(r.context.quotedMessage, '').slice(0, 200) } : null,
    })),
  };
}

async function guard(instance, jid) {
  if (!/^[0-9]+(-[0-9]+)?@(g\.us|s\.whatsapp\.net|lid)$/.test(jid)) throw httpError(400, 'bad chat id');
  const n = await one(`select * from desk.numbers where instance = $1`, [instance]);
  if (!n) throw httpError(404, 'Unknown number');
  if (n.role === 'reader') throw httpError(403, `${n.label} is the reader number. It never sends anything; reply from the group's sender number.`);
  if ((await connectionState(instance)) !== 'open') throw httpError(409, `${n.label} is not connected`);
}
const quotedOf = id => (typeof id === 'string' && /^[A-Za-z0-9]{6,64}$/.test(id) ? { quoted: { key: { id } } } : {});

// A person's own reply from the inbox. The person pressing Send is the approval.
export async function sendText(instance, jid, text, quotedId) {
  await guard(instance, jid);
  text = String(text || '').trim();
  if (!text) throw httpError(400, 'message text is empty');
  if (text.length > 4000) throw httpError(400, 'message is longer than 4000 characters');
  const res = await evo('POST', `/message/sendText/${encodeInstance(instance)}`, { number: jid, text, ...quotedOf(quotedId) });
  return { ok: true, id: res?.key?.id || null };
}

const MEDIA_TYPES = { image: /^image\/(jpeg|png|webp|gif)$/, video: /^video\//, audio: /^audio\//, document: /./ };
export async function sendMedia(instance, jid, b) {
  await guard(instance, jid);
  const mimetype = String(b.mimetype || '');
  let mediatype = ['image', 'video', 'audio', 'document'].includes(b.mediatype) ? b.mediatype : 'document';
  if (!MEDIA_TYPES[mediatype].test(mimetype)) mediatype = 'document';
  const base64 = String(b.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64.slice(0, 200))) throw httpError(400, 'file data missing');
  if (base64.length > 22 * 1024 * 1024) throw httpError(413, 'file is larger than 16 MB');
  const res = await evo('POST', `/message/sendMedia/${encodeInstance(instance)}`, { number: jid, mediatype, mimetype,
    caption: String(b.caption || '').slice(0, 1024), fileName: String(b.fileName || 'file').replace(/[\\/]/g, '_').slice(0, 120), media: base64, ...quotedOf(b.quotedId) });
  return { ok: true, id: res?.key?.id || null };
}

const mediaCache = new Map();
export async function mediaOf(instance, id) {
  const k = `${instance}|${id}`;
  if (mediaCache.has(k)) return mediaCache.get(k);
  const d = await evo('POST', `/chat/getBase64FromMediaMessage/${encodeInstance(instance)}`, { message: { key: { id } }, convertToMp4: false });
  const out = { mimetype: d?.mimetype || 'application/octet-stream', fileName: d?.fileName || null, base64: d?.base64 || '' };
  if (!out.base64) throw httpError(404, 'media not available (WhatsApp may have expired it)');
  mediaCache.set(k, out);
  while (mediaCache.size > 40) mediaCache.delete(mediaCache.keys().next().value);
  return out;
}

// Replies on a day, for every group of every number (not only reseller groups).
export async function repliesByDay(dayArg) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg || '') ? dayArg : istDate();
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
}

export async function listAlerts(show) {
  return q(`select a.*, r.code, r.name, o.name owner_name,
      (select subject from desk.groups g where g.jid = a.jid and subject is not null limit 1) group_name
    from desk.alerts a join desk.resellers r on r.id = a.reseller_id left join desk.owners o on o.id = a.owner_id
    where ($1 = 'all' or a.acked_at is null) order by a.acked_at nulls first, a.last_at desc limit 300`, [show === 'all' ? 'all' : 'open']);
}
