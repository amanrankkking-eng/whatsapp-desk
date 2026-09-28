// Stages 4-7: which batch runs today, the six checks, the message, and the day's preview.
import { q, one, tx, logEvent } from './db.mjs';
import { getSettings } from './settings.mjs';
import { ringLength } from './bind.mjs';
import { groupMessages, groupMemberPhones, summarise, LATEST_MEMBERS } from './read.mjs';
import { ladderState, renderRung, rungProblem } from './ladder.mjs';
import { istDate, istWeekday, istToUtc, now, randomGapSec, squash, httpError, addIstDays, daysBetween } from './util.mjs';
import { connectionState } from './evo.mjs';
import { OUT_STAGES } from './resellers.mjs';

export const CHECK_NAMES = ['gap', 'repeat', 'live conversation', 'unanswered question', 'someone to sell to', 'readable'];

// 51-55: today's batch is the ring's counter plus one. If a run already finished today the
// same batch is shown again, so re-running the day sends nothing twice.
export async function todaysBatches() {
  const n = await ringLength();
  const today = istDate();
  const state = await q(`select * from desk.ring_state`);
  const out = { ringLen: n };
  for (const ring of ['follow_up', 'offer']) {
    const st = state.find(x => x.ring === ring) || { last_batch: 0 };
    const ranToday = st.last_run_date && istDate(st.last_run_date) === today;
    out[ring] = ranToday ? st.last_batch : (st.last_batch % n) + 1;
    out[`${ring}_ran_today`] = !!ranToday;
  }
  return out;
}

// The date of a group's next turn in its ring, counting send days only.
export function nextTurn(batch, todayBatch, ringLen, ranToday, s) {
  if (!batch || !todayBatch) return null;
  let remaining = (batch - todayBatch + ringLen) % ringLen;
  if (ranToday) remaining = remaining === 0 ? ringLen - 1 : remaining - 1;
  let d = ranToday ? addIstDays(istDate(), 1) : istDate();
  for (let guard = 0; guard < 800; guard++) {
    if (s.send_days.includes(istWeekday(new Date(`${d}T12:00:00+05:30`)))) {
      if (remaining === 0) return d;
      remaining--;
    }
    d = addIstDays(d, 1);
  }
  return null;
}

// ---------------------------------------------------------------- the six checks (58-66)
export function runChecks(r, sum, rung, sentLabels, s) {
  const nowS = now().getTime() / 1000;
  const days = ts => Math.floor((nowS - ts) / 86400);
  const res = [];
  // 1. gap
  if (sum.lastOurs && days(sum.lastOurs.ts) < s.min_gap_days) res.push(['gap', `we last wrote ${days(sum.lastOurs.ts)} day(s) ago (needs ${s.min_gap_days})`]);
  // 2. repeat
  if (rung && sentLabels.has(rung.label)) res.push(['repeat', `${rung.label} already went to this group`]);
  // 3. live conversation
  if (sum.lastClient && days(sum.lastClient.ts) <= s.client_active_days) res.push(['live conversation', `the reseller wrote ${days(sum.lastClient.ts)} day(s) ago`]);
  else if (sum.lastOurs && days(sum.lastOurs.ts) <= s.our_active_days) res.push(['live conversation', `our side wrote ${days(sum.lastOurs.ts)} day(s) ago`]);
  // 4. unanswered question
  if (sum.lastClient && (!sum.lastOurs || sum.lastOurs.ts < sum.lastClient.ts) && days(sum.lastClient.ts) <= s.ball_in_court_days) {
    res.push(['unanswered question', `the reseller had the last word ${days(sum.lastClient.ts)} day(s) ago - answer first`]);
  }
  // 5. someone to sell to
  if (!sum.membersKnown) res.push(['someone to sell to', 'the member list for this group is empty']);
  else if (!sum.resellerIsMember) res.push(['someone to sell to', 'the reseller is no longer in the group']);
  // 6. readable
  if (!sum.readable) res.push(['readable', 'nothing can be read in this group - unknown, not quiet']);
  return res;
}

// 74-77: tag the reseller if they are safe to tag, else another single-group contact, else nobody.
async function resolveTag(r, s, taggedRecently) {
  const cands = await q(`
    select distinct coalesce(gm.phone, lm.phone) phone, coalesce(p.name, '') pname, coalesce(p.group_count, 1) gc,
      coalesce(p.is_ours, false) is_ours, (op.phone is not null) our_phone
    from ${LATEST_MEMBERS} gm
      left join desk.lid_map lm on lm.lid = gm.member_id
      left join desk.people p on p.member_id = gm.member_id
      left join desk.our_phones op on op.phone = coalesce(gm.phone, lm.phone)
    where gm.jid = $1`, [r.group_jid]);
  const ok = c => c.phone && !c.is_ours && !c.our_phone && c.gc === 1 && !Object.hasOwn(s.team_numbers || {}, c.phone) && !taggedRecently.has(c.phone);
  const reseller = cands.find(c => c.phone === r.phone);
  if (reseller && ok(reseller)) return { phone: reseller.phone, name: r.name || reseller.pname, why: 'the reseller' };
  const others = cands.filter(c => c.phone !== r.phone && ok(c)).sort((a, b) => a.phone.localeCompare(b.phone));
  if (others.length) return { phone: others[0].phone, name: others[0].pname, why: reseller ? 'the reseller was tagged recently - next contact' : 'the reseller is not in the group - next contact' };
  return null;
}

// ---------------------------------------------------------------- the day's preview (78)
export async function planDay({ forApproval = false } = {}) {
  const s = await getSettings();
  const today = istDate();
  const weekday = istWeekday();
  const batches = await todaysBatches();
  const ladder = await ladderState();
  const numbers = await q(`select * from desk.numbers order by sort`);
  const states = {};
  for (const n of numbers.filter(x => x.role === 'sender' && x.active)) states[n.instance] = await connectionState(n.instance);

  const all = await q(`select r.*, o.name owner_name from desk.resellers r left join desk.owners o on o.id = r.owner_id
    where r.group_jid is not null order by r.id`);
  const plan = { day: today, weekday, isSendDay: s.send_days.includes(weekday), batches, items: [], skips: [], needsStatus: [],
    waiting: [], paused: [], notInLoop: [], exhausted: [], inRun: [], notes: [] };
  // Groups already approved and waiting in a run are shown there, never offered for approval twice.
  const inRun = new Set((await q(`select reseller_id from desk.sends where status in ('queued','sending')`)).map(x => x.reseller_id));
  if (!plan.isSendDay) plan.notes.push(`${weekday} is not a send day (${s.send_days.join(', ')}).`);

  const todays = all.filter(r => (r.track === 'follow_up' && r.fu_batch === batches.follow_up) || (r.track === 'offer' && r.of_batch === batches.offer));
  for (const r of all) {
    if (!r.track && r.stage === 'live' && !r.paused && !r.hold && !r.dnc) plan.needsStatus.push({ id: r.id, code: r.code, name: r.name, reason: r.track_reason });
    if (r.paused && !OUT_STAGES.includes(r.stage)) plan.paused.push({ id: r.id, code: r.code, name: r.name, reason: r.pause_reason, since: r.last_reply_at });
  }
  // Longest-waiting group first (56).
  todays.sort((a, b) => (a.last_ours_at?.getTime() || 0) - (b.last_ours_at?.getTime() || 0) || a.id - b.id);

  const jids = todays.map(r => r.group_jid);
  const msgs = await groupMessages(jids);
  const members = await groupMemberPhones(jids);
  // A number is in a group when its own latest sync lists it there.
  const senderMember = new Set((await q(`select distinct gm.instance || '|' || gm.jid k from desk.group_members gm
    join desk.groups g on g.instance = gm.instance and g.jid = gm.jid and not g.left_group
    join desk.numbers n on n.instance = gm.instance and (gm.phone = n.phone or gm.member_id = n.lid) where gm.jid = any($1)`, [jids])).map(x => x.k));
  const sentLog = await q(`select reseller_id, rung_label from desk.send_log where reseller_id = any($1)`, [todays.map(r => r.id)]);
  const tagged = new Set((await q(`select distinct tagged from desk.send_log where tagged is not null and sent_at > $1`, [new Date(now().getTime() - s.tag_cooldown_days * 86400000)])).map(x => x.tagged));
  const sentToday = await q(`select instance, count(*)::int n from desk.send_log where sent_at >= $1 group by instance`, [istToUtc(today, '00:00')]);
  const laneUsed = Object.fromEntries(sentToday.map(x => [x.instance, x.n]));
  let totalLeft = s.daily_cap_total - sentToday.reduce((a, x) => a + x.n, 0);
  const headings = ladder.headings;
  const nextSlot = {};
  const windowStart = istToUtc(today, s.window_start).getTime(), windowEnd = istToUtc(today, s.window_end).getTime();
  const startAt = Math.max(now().getTime() + 60000, windowStart);

  const skip = (r, ring, reason, check = null) => plan.skips.push({ id: r.id, code: r.code, name: r.name, owner: r.owner_name, jid: r.group_jid,
    ring, reason, check, instance: r.instance });

  for (const r of todays) {
    if (inRun.has(r.id)) { plan.inRun.push({ id: r.id, code: r.code, name: r.name }); continue; }
    const ring = r.track;
    const batch = ring === 'follow_up' ? r.fu_batch : r.of_batch;
    const n = numbers.find(x => x.instance === r.instance);
    // 67: never-send, hold and do-not-contact never reach the checks.
    const name = (await one(`select subject from desk.groups where jid = $1 and subject is not null limit 1`, [r.group_jid]))?.subject || '';
    if (r.dnc || r.stage === 'dnc') { skip(r, ring, 'do not contact'); continue; }
    if (s.never_send_names.includes(name.trim().toLowerCase())) { skip(r, ring, 'group is on the never-send list'); continue; }
    if ((s.exclude_name_words || []).some(w => w && squash(name).includes(squash(w)))) { skip(r, ring, 'group name is excluded from the loop'); continue; }
    if (r.hold) { skip(r, ring, 'on hold'); continue; }
    if (OUT_STAGES.includes(r.stage)) { plan.notInLoop.push({ id: r.id, code: r.code, name: r.name, stage: r.stage }); continue; }
    if (r.stage !== 'live') { skip(r, ring, 'call 2 is not logged yet - the automation cannot touch this group'); continue; }
    if (r.paused) { skip(r, ring, r.pause_reason || 'paused'); continue; }
    if (!n || !n.active || n.role !== 'sender') { skip(r, ring, 'no active sender number owns this group'); continue; }
    if (states[r.instance] !== 'open') { skip(r, ring, `sender number ${n.label} is ${states[r.instance] || 'offline'}`); continue; }
    if (!senderMember.has(`${r.instance}|${r.group_jid}`)) { skip(r, ring, `sender number ${n.label} is not in this group`); continue; }
    // 5: a new number carries no real traffic until it has warmed up.
    const warmDay = n.warmup_started ? daysBetween(`${istDate(n.warmup_started)}T00:00:00Z`, `${today}T00:00:00Z`) + 1 : null;
    if (warmDay != null && warmDay <= s.warmup_days) { skip(r, ring, `sender number ${n.label} is still warming up (day ${warmDay} of ${s.warmup_days})`); continue; }

    // 68: the next message in this group's own ladder; a group cannot get the same one twice.
    const sent = new Set(sentLog.filter(x => x.reseller_id === r.id).map(x => x.rung_label));
    const ladderRungs = ladder.rungs.filter(x => x.ring === ring && x.active);
    const rung = ladderRungs.find(x => !sent.has(x.label));
    if (!rung) {
      plan.exhausted.push({ id: r.id, code: r.code, name: r.name, ring });
      if (forApproval) await q(`update desk.resellers set stage = 'exhausted', updated_at = now() where id = $1 and stage = 'live'`, [r.id]);
      continue;
    }
    const sum = summarise(msgs.get(r.group_jid) || [], members.get(r.group_jid) || new Set(), r);
    const failed = runChecks(r, sum, rung, sent, s);
    if (failed.length) { skip(r, ring, failed.map(f => f[1]).join('; '), failed.map(f => f[0]).join(', ')); continue; }
    if (rung.problem) { skip(r, ring, `${rung.label} ${rung.problem}`, 'message'); continue; }

    // 84: caps per sender and for the whole day.
    const used = laneUsed[r.instance] || 0;
    if (used >= n.daily_cap) { skip(r, ring, `${n.label} reached its daily cap of ${n.daily_cap}`); continue; }
    if (totalLeft <= 0) { skip(r, ring, `the day's total cap of ${s.daily_cap_total} is reached`); continue; }

    // 81-83: one at a time per number, random 5-14 minute gaps, inside the window.
    const at = nextSlot[r.instance] || startAt;
    if (at > windowEnd) { skip(r, ring, `falls after ${s.window_end}, the end of the sending window`); continue; }

    // 69-77: build the text.
    const pkg = rung.package_id ? ladder.packages.find(p => p.id === rung.package_id) : null;
    const heading = headings.length ? headings[(plan.items.length + r.id) % headings.length] : null;
    let body = renderRung(rung, pkg, heading, s.business_name);
    const tag = await resolveTag(r, s, tagged);
    const lines = [];
    if (tag) lines.push(s.greeting_template.replace('{tag}', tag.phone));
    if (r.intro_pending) lines.push(s.intro_template.replace('{sender_name}', n.profile_name || n.label));
    const text = [...lines, body].join('\n\n');
    if (tag) tagged.add(tag.phone);
    laneUsed[r.instance] = used + 1;
    totalLeft--;
    nextSlot[r.instance] = at + randomGapSec(s.gap_min_sec, s.gap_max_sec) * 1000;
    plan.items.push({
      id: r.id, code: r.code, name: r.name, owner: r.owner_name, jid: r.group_jid, group: name, instance: r.instance, sender: n.label,
      ring, batch, rungId: rung.id, rungLabel: rung.label, packageLabel: pkg?.label || null, headingId: heading?.id || null,
      why: `${ring === 'follow_up' ? 'Follow-up' : 'Offer'} ring, batch ${batch} runs today; ${rung.label} is the next message this group has not had` +
        (r.track_source === 'manual' ? '; status set by a person' : r.track_reason ? `; status read from the chat (${r.track_reason})` : ''),
      text, tag, intro: !!r.intro_pending, scheduledAt: new Date(at).toISOString(),
    });
  }
  // 94: groups waiting for a follow-up, and how long.
  plan.waiting = all.filter(r => r.stage === 'live' && !r.paused && !inRun.has(r.id) && !plan.items.some(i => i.id === r.id))
    .map(r => ({ id: r.id, code: r.code, name: r.name, ring: r.track, days: r.last_ours_at ? Math.floor((now() - r.last_ours_at) / 86400000) : null,
      next: nextTurn(r.track === 'offer' ? r.of_batch : r.fu_batch, batches[r.track || 'follow_up'], batches.ringLen, batches[`${r.track || 'follow_up'}_ran_today`], s) }))
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  // 96: who is due tomorrow.
  const tomorrow = { follow_up: (batches.follow_up % batches.ringLen) + 1, offer: (batches.offer % batches.ringLen) + 1 };
  plan.dueTomorrow = all.filter(r => r.stage === 'live' && ((r.track === 'follow_up' && r.fu_batch === tomorrow.follow_up) || (r.track === 'offer' && r.of_batch === tomorrow.offer)))
    .map(r => ({ id: r.id, code: r.code, name: r.name, ring: r.track }));
  const queued = await q(`select instance, count(*)::int n from desk.sends where status in ('queued','sending') group by instance`);
  plan.senders = numbers.filter(x => x.role === 'sender').map(x => ({ instance: x.instance, label: x.label, state: states[x.instance] || 'inactive',
    planned: plan.items.filter(i => i.instance === x.instance).length, queued: queued.find(y => y.instance === x.instance)?.n || 0,
    cap: x.daily_cap, sentToday: (sentToday.find(y => y.instance === x.instance)?.n) || 0 }));
  return plan;
}

// 79-80: nothing sends until a person approves the preview. The plan is rebuilt here and only
// groups that were approved and still pass every check are queued.
export async function approveDay(approvedIds, who) {
  const running = await one(`select id from desk.runs where status = 'running'`);
  if (running) throw httpError(409, `Run #${running.id} is still sending. Stop it or wait for it to finish.`);
  const plan = await planDay({ forApproval: true });
  if (!plan.isSendDay) throw httpError(409, `${plan.weekday} is not a send day.`);
  const ids = new Set((approvedIds || []).map(Number));
  const items = plan.items.filter(i => ids.has(i.id));
  const dropped = [...ids].filter(id => !items.some(i => i.id === id));
  return tx(async t => {
    const [run] = await t(`insert into desk.runs (day, status, fu_batch, of_batch, ring_len, plan, approved_by)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [plan.day, items.length ? 'running' : 'done', plan.batches.follow_up, plan.batches.offer, plan.batches.ringLen,
        JSON.stringify({ items, skips: plan.skips, needsStatus: plan.needsStatus, exhausted: plan.exhausted, dropped }), who || null]);
    for (const i of items) {
      await t(`insert into desk.sends (run_id, reseller_id, instance, jid, ring, rung_id, rung_label, package_label, heading_id, text, tagged, tagged_name, scheduled_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [run.id, i.id, i.instance, i.jid, i.ring, i.rungId, i.rungLabel, i.packageLabel, i.headingId, i.text, i.tag?.phone || null, i.tag?.name || null, i.scheduledAt]);
    }
    for (const sk of plan.skips) {
      await t(`insert into desk.skips (day, run_id, reseller_id, jid, ring, reason) values ($1,$2,$3,$4,$5,$6)`,
        [plan.day, run.id, sk.id, sk.jid, sk.ring, sk.check ? `${sk.check}: ${sk.reason}` : sk.reason]);
    }
    if (!items.length) {
      // A day with nothing to send still ran its batches (54), so the counters move.
      await t(`update desk.ring_state set last_batch = case ring when 'follow_up' then $1::int else $2::int end, last_run_date = $3::date`,
        [plan.batches.follow_up, plan.batches.offer, plan.day]);
      await t(`update desk.runs set finished_at = now() where id = $1`, [run.id]);
    }
    await logEvent('run.approve', { run: run.id, queued: items.length, dropped: dropped.length }, who);
    return { runId: run.id, queued: items.length, dropped };
  });
}
