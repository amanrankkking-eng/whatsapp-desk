// Stage 7-8: sending an approved day, one message at a time per number, and recording it.
import { q, one, tx, logEvent } from './db.mjs';
import { evo, connectionState, encodeInstance } from './evo.mjs';
import { getSettings } from './settings.mjs';
import { groupMessages, groupMemberPhones, summarise } from './read.mjs';
import { runChecks, planDay, approveDay } from './plan.mjs';
import { istDate, istWeekday, istToUtc, now } from './util.mjs';
import { buildReports } from './reports.mjs';
import { opsAlert } from './monitor.mjs';

const busy = new Set();
// run|instance -> when that sender was first seen not connected during the run
const laneDownSince = new Map();

export async function stopRun(runId, reason, who) {
  const [claimed] = await q(`update desk.runs set status = 'stopped', stop_reason = $2, finished_at = $3 where id = $1 and status = 'running' returning id`, [runId, reason, now()]);
  if (!claimed) return { ok: false };
  await q(`update desk.sends set status = 'cancelled', error = $2 where run_id = $1 and status = 'queued'`, [runId, reason]);
  await logEvent('run.stop', { run: runId, reason }, who);
  // A person who pressed Stop knows; a run that stopped by itself is worth a message.
  if (!/^stopped by /.test(reason)) await opsAlert(`run-stop:${runId}`, `⏹ Run #${runId} stopped by itself: ${reason}. The messages not yet sent wait for their next turn.`, 0);
  // 85: the rest of the list is untouched and picked up next day: the counters do not move.
  await buildReports(runId).catch(e => console.error('[reports]', e.message));
  return { ok: true };
}

async function finishIfDone(runId) {
  const left = await one(`select count(*)::int n from desk.sends where run_id = $1 and status in ('queued','sending')`, [runId]);
  if (left.n > 0) return;
  const run = await one(`select * from desk.runs where id = $1`, [runId]);
  if (run.status !== 'running') return;
  const done = await tx(async t => {
    // Two lanes can finish at the same moment; only one of them closes the run.
    const [claimed] = await t(`update desk.runs set status = 'done', finished_at = $2 where id = $1 and status = 'running' returning id`, [runId, now()]);
    if (!claimed) return false;
    // 54-55: both counters move on a day a batch actually ran.
    await t(`update desk.ring_state set last_batch = case ring when 'follow_up' then $1::int else $2::int end, last_run_date = $3::date`,
      [run.fu_batch, run.of_batch, istDate(run.day)]);
    return true;
  });
  if (!done) return;
  await logEvent('run.done', { run: runId });
  await buildReports(runId).catch(e => console.error('[reports]', e.message));
}

// Called every few seconds. Each number sends its own queue, one message at a time.
export async function workerTick() {
  const runs = await q(`select * from desk.runs where status = 'running' order by id`);
  for (const run of runs) {
    const s = await getSettings();
    const lanes = await q(`select distinct instance from desk.sends where run_id = $1 and status = 'queued'`, [run.id]);
    if (!lanes.length) { await finishIfDone(run.id); continue; }
    // The sending window and send days are checked on every message, not only at approval.
    const today = istDate();
    const outOfWindow = !s.send_days.includes(istWeekday()) || now() > istToUtc(today, s.window_end) || istDate(run.day) !== today;
    if (outOfWindow) {
      const due = await one(`select count(*)::int n from desk.sends where run_id = $1 and status = 'queued'`, [run.id]);
      if (due.n) { await stopRun(run.id, `the sending window closed with ${due.n} message(s) still queued`); continue; }
    }
    // Each number is its own lane; lanes send side by side, each one message at a time.
    const lanesDone = [];
    for (const { instance } of lanes) {
      const key = `${run.id}|${instance}`;
      if (busy.has(key)) continue;
      busy.add(key);
      lanesDone.push(sendNext(run, instance, s).catch(e => console.error('[runner]', e)).finally(() => busy.delete(key)));
    }
    await Promise.all(lanesDone);
  }
}

// 54 and 105: a send day whose batches hold nothing to send is a rest day. Once the window has
// closed it is recorded as run, so the counters move. A day with sends waiting for approval is
// never closed automatically: without an approval the batch did not run and keeps its turn.
// Nor is a day on which Evolution API was down: nothing could run, so, like a stopped run, it
// costs nobody their turn (the same batch comes round next day). A single lost sender is
// different (125): the day closes, its groups wait for their next turn, and the ring keeps
// turning for everyone else.
export const OUTAGE_SKIP = /^sender number .+ is unreachable$/;
export async function closeRestDay() {
  const s = await getSettings();
  const today = istDate();
  if (!s.send_days.includes(istWeekday()) || now() < istToUtc(today, s.window_end)) return { closed: false };
  if (await one(`select 1 from desk.runs where day = $1`, [today])) return { closed: false };
  const plan = await planDay();
  if (plan.items.length) return { closed: false, waiting: plan.items.length };
  const outage = plan.skips.filter(k => OUTAGE_SKIP.test(k.reason));
  if (outage.length) return { closed: false, outage: outage.length };
  const r = await approveDay([], 'auto (nothing to send)');
  return { closed: true, run: r.runId };
}

// Skips every message still queued for one sender in this run and tells the team.
async function dropLane(run, instance, state) {
  const n = await one(`select label, phone from desk.numbers where instance = $1`, [instance]);
  const label = n?.label || instance;
  const reason = `sender ${label} is ${state} - its groups wait for their next turn`;
  const rows = await q(`update desk.sends set status = 'skipped', error = $3 where run_id = $1 and instance = $2 and status = 'queued'
    returning reseller_id, jid, ring`, [run.id, instance, reason]);
  for (const x of rows) {
    await q(`insert into desk.skips (day, run_id, reseller_id, jid, ring, reason) values ($1,$2,$3,$4,$5,$6)`,
      [istDate(run.day), run.id, x.reseller_id, x.jid, x.ring, reason]);
  }
  await logEvent('run.lane-drop', { run: run.id, instance, state, skipped: rows.length });
  await opsAlert(`lane-drop:${run.id}:${instance}`, `⏸ ${label}${n?.phone ? ` (+${n.phone})` : ''} disconnected (${state}) during run #${run.id}. ` +
    `Its ${rows.length} remaining message(s) are skipped and wait for their next turn; the other senders keep sending.`, 0);
  await finishIfDone(run.id);
}

async function sendNext(run, instance, s) {
  const send = await one(`select * from desk.sends where run_id = $1 and instance = $2 and status = 'queued' and scheduled_at <= $3
    order by scheduled_at limit 1`, [run.id, instance, now()]);
  if (!send) return;
  const fresh = await one(`select status from desk.runs where id = $1`, [run.id]);
  if (fresh.status !== 'running') return;
  const r = await one(`select * from desk.resellers where id = $1`, [send.reseller_id]);
  const skipSend = async reason => {
    await q(`update desk.sends set status = 'skipped', error = $2 where id = $1`, [send.id, reason]);
    await q(`insert into desk.skips (day, run_id, reseller_id, jid, ring, reason) values ($1,$2,$3,$4,$5,$6)`,
      [istDate(run.day), run.id, send.reseller_id, send.jid, send.ring, reason]);
    await finishIfDone(run.id);
  };
  // 67: stopped rows never reach the send, even if they changed after approval.
  if (!r || r.dnc || r.hold || r.paused || r.stage !== 'live' || r.group_jid !== send.jid || r.instance !== instance) {
    return skipSend(!r ? 'row deleted' : r.dnc ? 'do not contact' : r.hold ? 'put on hold' : r.paused ? (r.pause_reason || 'paused')
      : r.stage !== 'live' ? `stage changed to ${r.stage}` : 'the group or its sender changed after approval');
  }
  // 58-63 again, read live at the moment of sending.
  const msgs = await groupMessages([send.jid]);
  const members = await groupMemberPhones([send.jid]);
  const sum = summarise(msgs.get(send.jid) || [], members.get(send.jid) || new Set(), r);
  const sent = new Set((await q(`select rung_label from desk.send_log where reseller_id = $1`, [r.id])).map(x => x.rung_label));
  const failed = runChecks(r, sum, { label: send.rung_label }, sent, s);
  if (failed.length) return skipSend(`${failed.map(f => f[0]).join(', ')}: ${failed.map(f => f[1]).join('; ')}`);

  const state = await connectionState(instance);
  const laneKey = `${run.id}|${instance}`;
  if (state === 'unreachable') {
    // Evolution itself is not answering: nothing can send, so the whole run stops (85).
    await q(`update desk.sends set status = 'failed', error = $2 where id = $1`, [send.id, 'Evolution API is not answering']);
    return stopRun(run.id, 'Evolution API stopped answering - the run stopped at the first failure');
  }
  if (state !== 'open') {
    // 125-126: a lost number stops only its own slice. A short reconnect is waited out; after
    // three minutes its messages in this run are skipped (they wait for their ring's next
    // turn) and the other senders keep sending.
    if (!laneDownSince.has(laneKey)) laneDownSince.set(laneKey, now().getTime());
    if (now().getTime() - laneDownSince.get(laneKey) < 3 * 60000) return;
    laneDownSince.delete(laneKey);
    return dropLane(run, instance, state);
  }
  laneDownSince.delete(laneKey);
  await q(`update desk.sends set status = 'sending' where id = $1`, [send.id]);
  try {
    const body = { number: send.jid, text: send.text };
    if (send.tagged) body.mentioned = [send.tagged];
    const res = await evo('POST', `/message/sendText/${encodeInstance(instance)}`, body, 60000);
    const at = now();
    await tx(async t => {
      await t(`update desk.sends set status = 'sent', sent_at = $2, wa_msg_id = $3, response = $4 where id = $1`,
        [send.id, at, res?.key?.id || null, JSON.stringify({ key: res?.key || null, status: res?.status || null })]);
      // 86-89: the append-only record, written the moment the send succeeds.
      await t(`insert into desk.send_log (send_id, run_id, reseller_id, instance, jid, ring, rung_label, package_label, text, tagged, sent_at, wa_msg_id, response)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [send.id, run.id, r.id, instance, send.jid, send.ring, send.rung_label, send.package_label, send.text, send.tagged, at, res?.key?.id || null,
          JSON.stringify({ status: res?.status || null })]);
      await t(`update desk.resellers set last_ours_at = $2, last_msg_at = $2, last_msg_by = 'us', last_msg_text = left($3, 300),
        intro_pending = false, updated_at = now() where id = $1`, [r.id, at, send.text]);
    });
    await logEvent('send.ok', { run: run.id, reseller_id: r.id, rung: send.rung_label, instance });
  } catch (e) {
    await q(`update desk.sends set status = 'failed', error = $2 where id = $1`, [send.id, String(e.message).slice(0, 500)]);
    await logEvent('send.fail', { run: run.id, reseller_id: r.id, error: e.message });
    // 85: the first API error stops the run.
    return stopRun(run.id, `first API error: ${String(e.message).slice(0, 200)}`);
  }
  await finishIfDone(run.id);
}
