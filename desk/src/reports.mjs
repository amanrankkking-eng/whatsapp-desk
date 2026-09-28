// Stage 9 (what the team is told) and the owner alerts of Stage 11.
import { q, one } from './db.mjs';
import { cfg } from './config.mjs';
import { getSettings } from './settings.mjs';
import { istDate, istMinutes, hhmmToMin, now } from './util.mjs';

export async function postChat(webhook, text) {
  if (!webhook) return 'no webhook set';
  // Tests point every chat post at a local sink instead of Google.
  const target = cfg.test && process.env.TEST_CHAT_SINK ? `${process.env.TEST_CHAT_SINK}?to=${encodeURIComponent(webhook)}` : webhook;
  try {
    const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000) });
    return res.ok ? null : `Google Chat answered ${res.status}`;
  } catch (e) { return e.message; }
}

const fmtDays = d => (d == null ? 'never' : d === 0 ? 'today' : `${d} day${d === 1 ? '' : 's'}`);

// 91-98: one message for the team after the run, and a short brief for each owner.
export async function buildReports(runId) {
  const s = await getSettings();
  const run = await one(`select * from desk.runs where id = $1`, [runId]);
  if (!run) return;
  const day = istDate(run.day);
  const sent = await q(`select l.*, r.code, r.name, r.owner_id, g.subject from desk.send_log l join desk.resellers r on r.id = l.reseller_id
    left join lateral (select subject from desk.groups where jid = l.jid and subject is not null limit 1) g on true where l.run_id = $1 order by l.sent_at`, [runId]);
  const skips = await q(`select k.*, r.code, r.name, r.owner_id from desk.skips k left join desk.resellers r on r.id = k.reseller_id where k.run_id = $1`, [runId]);
  const needs = run.plan?.needsStatus || [];
  const pending = await q(`select a.*, r.code, r.name, r.owner_id, o.name owner_name from desk.alerts a join desk.resellers r on r.id = a.reseller_id
    left join desk.owners o on o.id = r.owner_id where a.acked_at is null order by a.first_at`);
  const waiting = await q(`select r.id, r.code, r.name, r.owner_id, r.last_ours_at from desk.resellers r
    where r.stage = 'live' and not r.paused and r.group_jid is not null
      and not exists (select 1 from desk.send_log l where l.reseller_id = r.id and l.run_id = $1)
    order by r.last_ours_at nulls first limit 40`, [runId]);
  const nowMs = now().getTime();
  const tomorrow = await q(`select r.code, r.name, r.track from desk.resellers r, desk.ring_state f, desk.ring_state o
    where f.ring = 'follow_up' and o.ring = 'offer' and r.stage = 'live' and not r.paused and r.group_jid is not null
      and ((r.track = 'follow_up' and r.fu_batch = (f.last_batch % $1) + 1) or (r.track = 'offer' and r.of_batch = (o.last_batch % $1) + 1))`,
    [run.ring_len || 1]);

  const lines = [];
  lines.push(`*WhatsApp Desk - ${day}* (run #${runId}, ${run.status})`);
  lines.push(`Sent: *${sent.length}*${sent.length ? ` - ${sent.map(x => `${x.name || x.code} (${x.rung_label})`).join(', ')}` : ''}`);
  const byCheck = {};
  for (const k of skips) (byCheck[k.reason.split(':')[0]] ||= []).push(k.name || k.code);
  lines.push(`Skipped: *${skips.length}*${skips.length ? '' : ''}`);
  for (const [check, names] of Object.entries(byCheck)) lines.push(`  • ${check}: ${names.join(', ')}`);
  if (run.stop_reason) lines.push(`Stopped: ${run.stop_reason}`);
  if (waiting.length) lines.push(`Waiting for their turn: ${waiting.slice(0, 15).map(w => `${w.name || w.code} (${fmtDays(w.last_ours_at ? Math.floor((nowMs - w.last_ours_at) / 86400000) : null)})`).join(', ')}${waiting.length > 15 ? ` and ${waiting.length - 15} more` : ''}`);
  if (needs.length) lines.push(`Need a status from a person: ${needs.map(n => n.name || n.code).join(', ')}`);
  if (tomorrow.length) lines.push(`Due tomorrow: ${tomorrow.map(t => t.name || t.code).join(', ')}`);
  if (pending.length) lines.push(`Unanswered replies: ${pending.map(p => `${p.name || p.code} -> ${p.owner_name || 'no owner'}`).join(', ')}`);
  const team = lines.join('\n');
  const err = await postChat(s.team_chat_webhook, team);
  await q(`insert into desk.reports (day, kind, title, body, posted_at, post_error) values ($1, 'team', $2, $3, $4, $5)`,
    [day, `Team summary ${day}`, team, err ? null : now(), err]);

  // 98: each owner gets their own short brief.
  const owners = await q(`select * from desk.owners where active`);
  for (const o of owners) {
    const mine = x => x.owner_id === o.id;
    const inLoop = await one(`select count(*)::int n from desk.resellers where owner_id = $1 and group_jid is not null and stage = 'live'`, [o.id]);
    const b = [`*${o.name} - your brief for ${day}*`,
      `Your groups in the loop: ${inLoop.n}`,
      `Sent into your groups today: ${sent.filter(mine).length}${sent.filter(mine).length ? ` (${sent.filter(mine).map(x => x.name || x.code).join(', ')})` : ''}`,
      `Skipped: ${skips.filter(mine).length}${skips.filter(mine).length ? ` (${skips.filter(mine).map(x => `${x.name || x.code}: ${x.reason.split(':')[0]}`).join('; ')})` : ''}`,
      `Replies waiting for you: ${pending.filter(mine).length}${pending.filter(mine).length ? ` (${pending.filter(mine).map(x => x.name || x.code).join(', ')})` : ''}`,
    ].join('\n');
    const e2 = o.chat_webhook ? await postChat(o.chat_webhook, b) : 'no webhook set';
    await q(`insert into desk.reports (day, kind, owner_id, title, body, posted_at, post_error) values ($1, 'owner', $2, $3, $4, $5, $6)`,
      [day, o.id, `${o.name} ${day}`, b, e2 ? null : now(), e2]);
  }
}

// 110-113: the alert goes to the group's owner by name and repeats until acknowledged.
export async function notifyAlerts() {
  const s = await getSettings();
  const m = istMinutes();
  if (m < hhmmToMin(s.alert_hours[0]) || m > hhmmToMin(s.alert_hours[1])) return { sent: 0 };
  const due = await q(`select a.*, r.code, r.name, r.phone, o.name owner_name, o.chat_webhook,
      (select subject from desk.groups g where g.jid = a.jid and subject is not null limit 1) subject
    from desk.alerts a join desk.resellers r on r.id = a.reseller_id left join desk.owners o on o.id = a.owner_id
    where a.acked_at is null and (a.last_notified_at is null or a.last_notified_at < $1)`,
    [new Date(now().getTime() - s.alert_repeat_min * 60000)]);
  let sentN = 0;
  for (const a of due) {
    const who = a.owner_name ? `*${a.owner_name}*` : '*No owner set*';
    const what = a.kind === 'stop' ? 'asked us to STOP (row set to do-not-contact)' : a.kind === 'left' ? 'left the group' : `replied (${a.count} message${a.count > 1 ? 's' : ''})`;
    const text = `${who}: ${a.name || a.code} (${a.code}) ${what} in "${a.subject || 'their group'}".\n> ${String(a.text || '').slice(0, 600).replace(/\n/g, '\n> ')}\n` +
      `Reminder ${a.notify_count + 1}. Acknowledge it on the Alerts page of WhatsApp Desk.`;
    const hook = a.chat_webhook || s.team_chat_webhook;
    const err = hook ? await postChat(hook, text) : 'no webhook set';
    await q(`update desk.alerts set last_notified_at = $2, notify_count = notify_count + 1 where id = $1`, [a.id, now()]);
    if (!err) sentN++;
  }
  return { sent: sentN };
}

export async function ackAlert(id, who) {
  await q(`update desk.alerts set acked_at = $2, acked_by = $3 where id = $1 and acked_at is null`, [id, now(), who || 'dashboard']);
  return { ok: true };
}
