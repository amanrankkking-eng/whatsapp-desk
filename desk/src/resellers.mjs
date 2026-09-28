// Stage 1 - a lead becomes a reseller row: import, calls, owners, statuses and exits.
import { q, one, tx, logEvent } from './db.mjs';
import { normalizePhone, parseCsv, httpError, now } from './util.mjs';
import { assignBatches } from './bind.mjs';

export const CALL_OUTCOMES = ['Interested', 'Call back later', 'Not reachable', 'Busy', 'Not interested', 'Wrong number', 'Not on WhatsApp'];
const NEGATIVE = { 'Not interested': 'not_interested', 'Wrong number': 'invalid', 'Not on WhatsApp': 'invalid' };
export const STAGES = {
  new: 'New lead', called_1: 'Call 1 done', offer_sent: 'First offer sent', live: 'In the loop',
  active_reseller: 'Order placed', not_interested: 'Not interested', dnc: 'Do not contact',
  exhausted: 'Every message used', invalid: 'Invalid number',
};
export const OUT_STAGES = ['active_reseller', 'not_interested', 'dnc', 'exhausted', 'invalid'];

// ---------------------------------------------------------------- owners
export async function listOwners() {
  return q(`select o.*, (select count(*)::int from desk.resellers r where r.owner_id = o.id) resellers from desk.owners o order by o.name`);
}
export async function saveOwner(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw httpError(400, 'Owner name is empty');
  const phone = b.phone ? normalizePhone(b.phone) : { ok: true, phone: null };
  if (!phone.ok) throw httpError(400, `Owner phone: ${phone.reason}`);
  const hook = String(b.chat_webhook || '').trim();
  if (hook && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/\S+$/.test(hook)) throw httpError(400, 'The alert webhook must be a Google Chat webhook URL');
  if (b.id) await q(`update desk.owners set name=$2, phone=$3, chat_webhook=$4, active=$5 where id=$1`, [b.id, name, phone.phone, hook || null, b.active !== false]);
  else await q(`insert into desk.owners (name, phone, chat_webhook) values ($1,$2,$3)`, [name, phone.phone, hook || null]);
  return { ok: true };
}
export async function deleteOwner(id) {
  const r = await one(`select count(*)::int n from desk.resellers where owner_id = $1`, [id]);
  if (r.n) throw httpError(409, `This owner still has ${r.n} resellers. Give them to someone else first.`);
  await q(`delete from desk.owners where id = $1`, [id]);
  return { ok: true };
}

// ---------------------------------------------------------------- leads
async function nextCode(t) {
  const [r] = await t(`select coalesce(max(substring(code from 2)::int), 0) + 1 n from desk.resellers where code ~ '^R[0-9]+$'`);
  return `R${String(r.n).padStart(4, '0')}`;
}

// 19-21: pull leads in, normalise every number, reject malformed ones and duplicates with a reason.
export async function importLeads({ csv, rows: givenRows, source, owner_id }) {
  let rows = givenRows;
  if (!rows) {
    const table = parseCsv(csv || '');
    if (!table.length) throw httpError(400, 'Nothing to import');
    const header = table[0].map(h => h.trim().toLowerCase());
    const find = (...names) => header.findIndex(h => names.some(n => h === n || h.includes(n)));
    const iPhone = find('phone', 'mobile', 'whatsapp', 'number', 'contact');
    if (iPhone < 0) throw httpError(400, 'No phone column. Name one column "phone" (or mobile / whatsapp / number).');
    const iName = find('name'), iCompany = find('company', 'agency', 'business'), iCity = find('city', 'location'),
      iEmail = find('email', 'mail'), iOwner = find('owner', 'assigned'), iNotes = find('note', 'remark', 'comment');
    rows = table.slice(1).map(r => ({ name: r[iName] ?? '', phone: r[iPhone] ?? '', company: iCompany >= 0 ? r[iCompany] : '',
      city: iCity >= 0 ? r[iCity] : '', email: iEmail >= 0 ? r[iEmail] : '', owner: iOwner >= 0 ? r[iOwner] : '', notes: iNotes >= 0 ? r[iNotes] : '' }));
  }
  const owners = await q(`select id, lower(name) n from desk.owners`);
  const out = { added: [], rejected: [] };
  await tx(async t => {
    const seen = new Set();
    for (const raw of rows) {
      const p = normalizePhone(raw.phone);
      const reject = async reason => { out.rejected.push({ ...raw, reason }); await t(`insert into desk.lead_rejects (raw, reason) values ($1,$2)`, [JSON.stringify(raw), reason]); };
      if (!p.ok) { await reject(p.reason); continue; }
      if (seen.has(p.phone)) { await reject('appears twice in this import'); continue; }
      seen.add(p.phone);
      const dup = (await t(`select code from desk.resellers where phone = $1`, [p.phone]))[0];
      if (dup) { await reject(`already a row (${dup.code})`); continue; }
      const own = raw.owner ? owners.find(o => o.n === String(raw.owner).trim().toLowerCase())?.id : null;
      const code = await nextCode(t);
      await t(`insert into desk.resellers (code, name, phone, phone_raw, company, city, email, source, owner_id, notes)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [code, String(raw.name || '').trim().slice(0, 120), p.phone, String(raw.phone), String(raw.company || '').slice(0, 120),
          String(raw.city || '').slice(0, 80), String(raw.email || '').slice(0, 120), String(source || 'import').slice(0, 80),
          own || (owner_id ? Number(owner_id) : null), String(raw.notes || '').slice(0, 1000)]);
      out.added.push({ code, name: raw.name, phone: p.phone });
    }
  });
  await logEvent('leads.import', { added: out.added.length, rejected: out.rejected.length, source });
  return out;
}

export async function addReseller(b) {
  const r = await importLeads({ rows: [b], source: 'added by hand', owner_id: b.owner_id });
  if (!r.added.length) throw httpError(400, r.rejected[0]?.reason || 'Could not add');
  return r.added[0];
}

// ---------------------------------------------------------------- list and detail
export async function listResellers() {
  return q(`select r.*, o.name owner_name, n.label sender_label, n.state sender_state,
      (select g.subject from desk.groups g where g.jid = r.group_jid order by g.synced_at desc nulls last limit 1) group_name,
      (select count(*)::int from desk.send_log s where s.reseller_id = r.id) sends,
      (select count(*)::int from desk.replies y where y.reseller_id = r.id) replies_count,
      (select count(*)::int from desk.alerts a where a.reseller_id = r.id and a.acked_at is null) open_alerts
    from desk.resellers r left join desk.owners o on o.id = r.owner_id left join desk.numbers n on n.instance = r.instance
    order by r.id`);
}

export async function resellerDetail(id) {
  const r = await one(`select r.*, o.name owner_name, n.label sender_label from desk.resellers r
    left join desk.owners o on o.id = r.owner_id left join desk.numbers n on n.instance = r.instance where r.id = $1`, [id]);
  if (!r) throw httpError(404, 'Unknown reseller');
  const sends = await q(`select * from desk.send_log where reseller_id = $1 order by sent_at desc limit 100`, [id]);
  const replies = await q(`select * from desk.replies where reseller_id = $1 order by ts desc limit 100`, [id]);
  const skips = await q(`select * from desk.skips where reseller_id = $1 order by created_at desc limit 30`, [id]);
  const events = await q(`select * from desk.events where detail->>'reseller_id' = $1::text order by ts desc limit 50`, [String(id)]);
  return { reseller: r, sends, replies, skips, events };
}

// ---------------------------------------------------------------- calls and statuses
export async function logCall(id, { call, outcome, note }, who) {
  const r = await one(`select * from desk.resellers where id = $1`, [id]);
  if (!r) throw httpError(404, 'Unknown reseller');
  if (![1, 2].includes(Number(call))) throw httpError(400, 'Call must be 1 or 2');
  if (!CALL_OUTCOMES.includes(outcome)) throw httpError(400, 'Pick an outcome from the list');
  note = String(note || '').slice(0, 500);
  let stage = r.stage;
  if (NEGATIVE[outcome]) stage = NEGATIVE[outcome];
  else if (Number(call) === 1 && stage === 'new') stage = 'called_1';
  else if (Number(call) === 2 && !OUT_STAGES.includes(stage)) stage = 'live';   // 31: call 2 logged is the switch
  if (Number(call) === 1) await q(`update desk.resellers set call1_outcome=$2, call1_note=$3, call1_at=now(), stage=$4, updated_at=now() where id=$1`, [id, outcome, note, stage]);
  else await q(`update desk.resellers set call2_outcome=$2, call2_note=$3, call2_at=now(), stage=$4, updated_at=now() where id=$1`, [id, outcome, note, stage]);
  await logEvent('reseller.call', { reseller_id: id, call: Number(call), outcome, note, stage }, who);
  return { stage };
}

// 45/49: a status written by a person always wins over the one read from the chat.
export async function setTrack(id, track, who) {
  if (![null, 'follow_up', 'offer'].includes(track)) throw httpError(400, 'Status must be follow-up, offer or cleared');
  await q(`update desk.resellers set track=$2, track_source=$3, track_reason=$4, track_at=now(), updated_at=now() where id=$1`,
    [id, track, track ? 'manual' : null, track ? `set by ${who || 'a person'}` : null]);
  await logEvent('reseller.track', { reseller_id: id, track }, who);
  return { ok: true };
}

const ACTIONS = {
  // 17 / 118-122: how a person closes or reopens a row.
  resume: { set: `paused=false, pause_reason=null`, note: 'conversation over, back in the loop' },
  hold: { set: `hold=true`, note: 'put on hold' },
  unhold: { set: `hold=false`, note: 'hold lifted' },
  order_placed: { set: `stage='active_reseller', paused=false`, note: 'order placed - active reseller' },
  dnc: { set: `stage='dnc', dnc=true`, note: 'asked to stop - do not contact' },
  undo_dnc: { set: `stage=case when call2_at is not null then 'live' else 'called_1' end, dnc=false`, note: 'do-not-contact removed' },
  invalid: { set: `stage='invalid'`, note: 'wrong number or not on WhatsApp' },
  not_interested: { set: `stage='not_interested'`, note: 'not interested' },
  reopen: { set: `stage=case when call2_at is not null then 'live' else 'called_1' end, paused=false, pause_reason=null, left_group=false`, note: 'put back into the loop by hand' },
  first_offer_sent: { set: `first_offer_at=coalesce(first_offer_at, now()), stage=case when stage in ('new','called_1') then 'offer_sent' else stage end`, note: 'first offer marked as sent' },
};
export async function applyAction(id, action, who) {
  const a = ACTIONS[action];
  if (!a) throw httpError(400, 'Unknown action');
  await q(`update desk.resellers set ${a.set}, updated_at=now() where id=$1`, [id]);
  if (['resume', 'order_placed', 'dnc', 'invalid', 'not_interested'].includes(action)) {
    await q(`update desk.alerts set acked_at = coalesce(acked_at, now()), acked_by = coalesce(acked_by, $2) where reseller_id = $1 and acked_at is null`, [id, who || 'closed with the row']);
  }
  await logEvent('reseller.action', { reseller_id: id, action, note: a.note }, who);
  return { ok: true };
}

export async function updateReseller(id, b, who) {
  const r = await one(`select * from desk.resellers where id = $1`, [id]);
  if (!r) throw httpError(404, 'Unknown reseller');
  const fields = {};
  for (const k of ['name', 'company', 'city', 'email', 'notes']) if (b[k] !== undefined) fields[k] = String(b[k]).slice(0, k === 'notes' ? 2000 : 120);
  if (b.owner_id !== undefined) fields.owner_id = b.owner_id ? Number(b.owner_id) : null;
  if (b.phone !== undefined) {
    const p = normalizePhone(b.phone);
    if (!p.ok) throw httpError(400, p.reason);
    const dup = await one(`select code from desk.resellers where phone = $1 and id <> $2`, [p.phone, id]);
    if (dup) throw httpError(409, `That number is already ${dup.code}`);
    fields.phone = p.phone;
  }
  const keys = Object.keys(fields);
  if (!keys.length) return { ok: true };
  await q(`update desk.resellers set ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() where id=$1`, [id, ...keys.map(k => fields[k])]);
  await logEvent('reseller.edit', { reseller_id: id, fields: keys }, who);
  return { ok: true };
}

// 37: when the automatic binding could not decide, a person binds the group by hand.
export async function bindByHand(id, { instance, jid }, who) {
  const r = await one(`select * from desk.resellers where id = $1`, [id]);
  if (!r) throw httpError(404, 'Unknown reseller');
  const g = await one(`select * from desk.groups where instance = $1 and jid = $2 and not left_group`, [instance, jid]);
  if (!g) throw httpError(404, 'That number is not in that group');
  const n = await one(`select * from desk.numbers where instance = $1`, [instance]);
  if (!n || n.role !== 'sender') throw httpError(400, 'Bind the group to a sender number, not the reader');
  const other = await one(`select code from desk.resellers where group_jid = $1 and id <> $2`, [jid, id]);
  if (other) throw httpError(409, `That group is already bound to ${other.code}`);
  await tx(async t => {
    await t(`update desk.resellers set group_jid=$2, instance=$3, bound_at=$5, bound_by=$4, left_group=false, updated_at=now() where id=$1`, [id, jid, instance, who || 'by hand', now()]);
    await t(`delete from desk.bind_issues where jid = $1`, [jid]);
  });
  await assignBatches(id);
  await logEvent('reseller.bind', { reseller_id: id, jid, instance, by: 'hand' }, who);
  return { ok: true };
}

export async function unbind(id, who) {
  await q(`update desk.resellers set group_jid=null, instance=null, bound_at=null, bound_by=null, fu_batch=null, of_batch=null, updated_at=now() where id=$1`, [id]);
  await logEvent('reseller.unbind', { reseller_id: id }, who);
  return { ok: true };
}

// 125-127: a lost sender's slice moves to another number, which opens by saying who is writing.
export async function moveSlice(from, to, who) {
  const n = await one(`select * from desk.numbers where instance = $1`, [to]);
  if (!n || n.role !== 'sender') throw httpError(400, 'Move the slice to a sender number');
  if (from === to) throw httpError(400, 'Pick a different number');
  const rows = await q(`update desk.resellers set instance=$2, intro_pending=true, updated_at=now() where instance=$1 and group_jid is not null returning id`, [from, to]);
  await logEvent('slice.move', { from, to, count: rows.length }, who);
  return { moved: rows.length };
}
