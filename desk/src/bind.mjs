// Stage 2 - a group is bound to its reseller row, by member phone number only.
import { q, one, tx, logEvent } from './db.mjs';
import { getSettings } from './settings.mjs';
import { LATEST_MEMBERS } from './read.mjs';
import { squash, now } from './util.mjs';

// 33-39: read who is in each unbound group, strip our side, match what is left against the
// sheet's phone numbers. Exactly one match binds; anything else is reported for a person.
export async function bindGroups() {
  const s = await getSettings();
  const groups = await q(`
    select g.jid, max(g.subject) subject, array_agg(distinct g.instance) instances, bool_and(g.preexisting) preexisting
    from desk.groups g
    where not g.left_group and not g.is_community
      and not exists (select 1 from desk.resellers r where r.group_jid = g.jid)
    group by g.jid`);
  // Excluded names (another project's groups) and never-send rooms are never bound or reported.
  const blocked = g => {
    const name = String(g.subject || '');
    return s.never_send_names.includes(name.trim().toLowerCase()) || (s.exclude_name_words || []).some(w => w && squash(name).includes(squash(w)));
  };
  for (let i = groups.length - 1; i >= 0; i--) if (blocked(groups[i])) groups.splice(i, 1);
  if (!groups.length) return { bound: 0 };
  const senders = await q(`select instance, phone, lid from desk.numbers where role = 'sender' and active and phone is not null`);
  const members = await q(`
    select gm.jid, gm.instance, gm.member_id, coalesce(gm.phone, lm.phone) phone, coalesce(p.is_ours, false) is_ours,
      (op.phone is not null) our_phone
    from ${LATEST_MEMBERS} gm
      left join desk.lid_map lm on lm.lid = gm.member_id
      left join desk.people p on p.member_id = gm.member_id
      left join desk.our_phones op on op.phone = coalesce(gm.phone, lm.phone)
    where gm.jid = any($1)`, [groups.map(g => g.jid)]);
  const resellers = await q(`select id, code, phone, group_jid from desk.resellers where stage not in ('invalid')`);
  const byPhone = new Map(resellers.map(r => [r.phone, r]));
  let bound = 0;
  for (const g of groups) {
    const mem = members.filter(m => m.jid === g.jid);
    const theirs = [...new Set(mem.filter(m => !m.is_ours && !m.our_phone && m.phone).map(m => m.phone))];
    const matches = [...new Set(theirs.filter(p => byPhone.has(p)).map(p => byPhone.get(p)))];
    const report = async (reason, detail = {}) => {
      await q(`insert into desk.bind_issues (jid, reason, detail) values ($1,$2,$3)
        on conflict (jid) do update set reason = excluded.reason, detail = excluded.detail, seen_at = now()`,
        [g.jid, reason, JSON.stringify({ subject: g.subject, ...detail })]);
    };
    if (!matches.length) {
      // Only groups that hold a sender number are candidates for the loop at all.
      const hasSender = mem.some(m => senders.some(sn => sn.phone === m.phone || (sn.lid && sn.lid === m.member_id)));
      if (hasSender && !g.preexisting) await report('no member matches a reseller phone number', { phones: theirs.slice(0, 10) });
      continue;
    }
    if (matches.length > 1) { await report('several resellers are members', { codes: matches.map(r => r.code) }); continue; }
    const r = matches[0];
    if (r.group_jid && r.group_jid !== g.jid) { await report(`${r.code} already has a different group`, { code: r.code }); continue; }
    const inGroup = senders.filter(sn => mem.some(m => m.phone === sn.phone || (sn.lid && sn.lid === m.member_id)));
    if (!inGroup.length) { await report(`matches ${r.code} but no sender number is in the group`, { code: r.code }); continue; }
    if (inGroup.length > 1) { await report(`matches ${r.code} but ${inGroup.length} sender numbers are in the group - keep one`, { code: r.code, senders: inGroup.map(x => x.instance) }); continue; }
    const note = g.subject && !squash(g.subject).includes(squash(r.code)) ? `group name does not mention ${r.code}` : null;
    await tx(async t => {
      await t(`update desk.resellers set group_jid=$2, instance=$3, bound_at=$4, bound_by='auto', left_group=false, updated_at=now() where id=$1 and group_jid is null`,
        [r.id, g.jid, inGroup[0].instance, now()]);
      await t(`delete from desk.bind_issues where jid = $1`, [g.jid]);
    });
    await assignBatches(r.id);
    await logEvent('reseller.bind', { reseller_id: r.id, jid: g.jid, instance: inGroup[0].instance, by: 'auto', note });
    bound++;
  }
  return { bound };
}

// 40: one batch of each ring, half a ring apart. A new group joins the batch with the fewest
// members; a new batch is appended when every batch is full. Never a reshuffle.
export async function assignBatches(id) {
  const s = await getSettings();
  const r = await one(`select fu_batch, of_batch from desk.resellers where id = $1`, [id]);
  if (!r || r.fu_batch) return;
  const counts = await q(`select fu_batch b, count(*)::int n from desk.resellers where fu_batch is not null group by fu_batch`);
  const k = counts.reduce((m, c) => Math.max(m, c.b), 0);
  let fu = null, best = Infinity;
  for (let b = 1; b <= k; b++) {
    const n = counts.find(c => c.b === b)?.n || 0;
    if (n < s.batch_size && n < best) { best = n; fu = b; }
  }
  if (!fu) fu = k + 1;
  const ringLen = Math.max(fu, k, s.ring_min_batches);
  const of = ((fu - 1 + Math.floor(ringLen / 2)) % ringLen) + 1;
  await q(`update desk.resellers set fu_batch = $2, of_batch = $3 where id = $1`, [id, fu, of]);
}

export async function ringLength() {
  const s = await getSettings();
  const [r] = await q(`select greatest(coalesce(max(fu_batch), 0), coalesce(max(of_batch), 0))::int k from desk.resellers`);
  return Math.max(r.k, s.ring_min_batches);
}

export async function listBindIssues() {
  return q(`select * from desk.bind_issues order by ignored, seen_at desc`);
}
export async function ignoreIssue(jid, ignored) {
  await q(`update desk.bind_issues set ignored = $2 where jid = $1`, [jid, !!ignored]);
  return { ok: true };
}
