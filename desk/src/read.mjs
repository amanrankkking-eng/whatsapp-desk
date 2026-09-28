// Stage 3 (the read), Stage 4 (which ring, read from the chat) and Stage 11 (replies).
import { q, one, logEvent } from './db.mjs';
import { TEXT_SQL, typeLabel, buyingSignal, STOP_RE, now } from './util.mjs';

// A group's member list as seen by whichever of our numbers synced it last. Numbers sync at
// different times; mixing their lists would keep someone who has already left.
export const LATEST_MEMBERS = `(select gm.* from desk.group_members gm join (select distinct on (jid) instance, jid from desk.groups
  where not left_group order by jid, synced_at desc nulls last) l on l.instance = gm.instance and l.jid = gm.jid)`;

// All messages of the given groups, once each, whichever of our numbers stored them.
export async function groupMessages(jids, sinceSec = 0) {
  if (!jids.length) return new Map();
  const rows = await q(`
    select distinct on (jid, id, from_me) jid, id, row_id, from_me, ours, ts, type, sender_phone, sender_name, ${TEXT_SQL} txt, context
    from desk.msgx where jid = any($1) and ts >= $2
    order by jid, id, from_me, ts`, [jids, sinceSec]);
  const out = new Map(jids.map(j => [j, []]));
  for (const r of rows) {
    r.ts = Number(r.ts);
    r.text = typeLabel(r.type, r.txt);
    out.get(r.jid)?.push(r);
  }
  // Same-second messages keep the order they were stored in (Evolution's row ids grow with time).
  for (const list of out.values()) list.sort((a, b) => a.ts - b.ts || (a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0));
  return out;
}

export async function groupMemberPhones(jids) {
  const rows = await q(`select distinct gm.jid, coalesce(gm.phone, lm.phone) phone from ${LATEST_MEMBERS} gm
      left join desk.lid_map lm on lm.lid = gm.member_id
    where gm.jid = any($1)`, [jids]);
  const out = new Map(jids.map(j => [j, new Set()]));
  for (const r of rows) if (r.phone) out.get(r.jid).add(r.phone);
  return out;
}

// Everything the checks and the row need about one group, from its messages and members.
export function summarise(msgs, members, reseller) {
  const ours = msgs.filter(m => m.ours), theirs = msgs.filter(m => !m.ours);
  const last = msgs[msgs.length - 1] || null;
  return {
    readable: msgs.length > 0,
    count: msgs.length,
    last,
    lastOurs: ours[ours.length - 1] || null,
    lastClient: theirs[theirs.length - 1] || null,
    firstOurs: ours[0] || null,
    theirs,
    resellerIsMember: reseller.phone ? members.has(reseller.phone) : false,
    membersKnown: members.size > 0,
  };
}

// 41-44: every bound group is read every day (here: every few minutes, reading is free).
export async function readGroups() {
  const rows = await q(`select * from desk.resellers where group_jid is not null`);
  if (!rows.length) return { read: 0 };
  const jids = rows.map(r => r.group_jid);
  const msgs = await groupMessages(jids);
  const members = await groupMemberPhones(jids);
  for (const r of rows) {
    const s = summarise(msgs.get(r.group_jid) || [], members.get(r.group_jid) || new Set(), r);
    const leftNow = s.membersKnown && !s.resellerIsMember;
    const firstOffer = r.first_offer_at || (s.firstOurs ? new Date(s.firstOurs.ts * 1000) : null);
    const stage = firstOffer && ['new', 'called_1'].includes(r.stage) ? 'offer_sent' : r.stage;
    await q(`update desk.resellers set readable=$2, last_msg_at=$3, last_msg_by=$4, last_msg_text=$5, last_ours_at=$6, last_client_at=$7,
        first_offer_at=$8, stage=$9, left_group = left_group or $10,
        paused = case when $10 and not left_group then true else paused end,
        pause_reason = case when $10 and not left_group then 'the reseller left the group' else pause_reason end
      where id=$1`,
      [r.id, s.readable, s.last ? new Date(s.last.ts * 1000) : null, s.last ? (s.last.ours ? 'us' : 'reseller') : null,
        s.last ? s.last.text.slice(0, 300) : null, s.lastOurs ? new Date(s.lastOurs.ts * 1000) : null,
        s.lastClient ? new Date(s.lastClient.ts * 1000) : null, firstOffer, stage, leftNow]);
    if (leftNow && !r.left_group) {
      // 121: paused, and a person is told. Never re-bound to whoever is left in the room.
      await raiseAlert(r, 'left', 'The reseller is no longer a member of the group. The group is paused.');
      await logEvent('reseller.left', { reseller_id: r.id, jid: r.group_jid });
    }
  }
  return { read: rows.length };
}

// 45-50: which ring. A status a person wrote always wins; otherwise read the chat.
export async function assignTracks() {
  const rows = await q(`select * from desk.resellers where group_jid is not null and coalesce(track_source, '') <> 'manual'`);
  if (!rows.length) return { changed: 0 };
  const msgs = await groupMessages(rows.map(r => r.group_jid));
  let changed = 0;
  for (const r of rows) {
    const list = msgs.get(r.group_jid) || [];
    let track = null, reason;
    if (!list.length) reason = 'cannot read the chat - needs a status from a person';
    else {
      const theirs = list.filter(m => !m.ours);
      const hit = theirs.map(m => ({ m, sig: buyingSignal(m.txt) })).filter(x => x.sig).pop();
      if (hit) { track = 'offer'; reason = `${hit.sig}: "${hit.m.text.slice(0, 120)}"`; }
      else if (theirs.length) { track = 'follow_up'; reason = 'replied, but no buying signal'; }
      else { track = 'follow_up'; reason = 'no reply yet'; }
    }
    if (track !== r.track || reason !== r.track_reason) {
      await q(`update desk.resellers set track=$2, track_source=$3, track_reason=$4, track_at=now() where id=$1`,
        [r.id, track, track ? 'chat' : null, reason]);
      changed++;
    }
  }
  return { changed };
}

// 106-117: a reseller's message pauses the ladder at once and alerts the group's owner by name.
// Messages from before the group was bound are history: recorded, and only raised when nobody
// on our side has answered them yet.
export async function detectReplies() {
  const rows = await q(`select * from desk.resellers where group_jid is not null`);
  if (!rows.length) return { replies: 0 };
  const sinceSec = Math.floor(now().getTime() / 1000) - 35 * 86400;
  const msgs = await groupMessages(rows.map(r => r.group_jid), sinceSec);
  let found = 0;
  for (const r of rows) {
    const list = msgs.get(r.group_jid) || [];
    const bound = r.bound_at ? r.bound_at.getTime() / 1000 : 0;
    // Nothing before our first message is a reply to anything.
    const start = r.first_offer_at ? r.first_offer_at.getTime() / 1000 : bound;
    const theirs = list.filter(m => !m.ours && m.ts > start);
    if (!theirs.length) continue;
    const known = new Set((await q(`select msg_id from desk.replies where jid = $1 and msg_id = any($2)`, [r.group_jid, theirs.map(m => m.id)])).map(x => x.msg_id));
    const fresh = theirs.filter(m => !known.has(m.id));
    if (!fresh.length) continue;
    const lastOursTs = list.filter(m => m.ours).reduce((mx, m) => Math.max(mx, m.ts), 0);
    let stop = false;
    for (const m of fresh) {
      const isStop = STOP_RE.test(m.txt || '');
      stop = stop || isStop;
      await q(`insert into desk.replies (msg_id, instance, jid, reseller_id, ts, sender, sender_name, text, signal, stop_word)
        values ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10) on conflict do nothing`,
        [m.id, r.instance || '', r.group_jid, r.id, m.ts, m.sender_phone, m.sender_name, m.text.slice(0, 4000), buyingSignal(m.txt), isStop]);
      found++;
    }
    const alertable = fresh.filter(m => m.ts >= bound - 600 || m.ts > lastOursTs);
    if (!alertable.length && !stop) continue;
    const lastMsg = fresh[fresh.length - 1];
    await q(`update desk.resellers set replied = true, last_reply_at = to_timestamp($2), last_reply_text = $3, paused = true,
        pause_reason = case when $4 then 'asked to stop' else 'replied - waiting for a person' end,
        dnc = dnc or $4, stage = case when $4 then 'dnc' else stage end, updated_at = now() where id = $1`,
      [r.id, lastMsg.ts, lastMsg.text.slice(0, 500), stop]);
    const text = (alertable.length ? alertable : fresh).map(m => m.text).join('\n').slice(0, 1500);
    await raiseAlert(r, stop ? 'stop' : 'reply', text, (alertable.length || fresh.length));
    await logEvent('reseller.reply', { reseller_id: r.id, count: fresh.length, stop });
  }
  return { replies: found };
}

// 114: five messages typed in a row are one alert, not five.
export async function raiseAlert(r, kind, text, count = 1) {
  const open = await one(`select id from desk.alerts where reseller_id = $1 and acked_at is null and kind = $2 order by id desc limit 1`, [r.id, kind]);
  if (open) {
    await q(`update desk.alerts set count = count + $2, text = left(coalesce(text, '') || E'\n' || $3, 3000), last_at = now() where id = $1`, [open.id, count, text]);
  } else {
    await q(`insert into desk.alerts (reseller_id, owner_id, instance, jid, kind, count, text) values ($1,$2,$3,$4,$5,$6,$7)`,
      [r.id, r.owner_id, r.instance, r.group_jid, kind, count, text]);
  }
}
