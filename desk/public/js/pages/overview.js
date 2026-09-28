// The first screen: numbers, today's work, what needs a person, and how the loop stands.
import { get, esc, icon, numberColor, stateLabel, dateTime, ago, niceDate } from '../core.js';
import { openAddWhatsApp } from './numbers.js';

const STAGE_ORDER = ['new', 'called_1', 'offer_sent', 'live', 'active_reseller', 'exhausted', 'not_interested', 'dnc', 'invalid'];

export default {
  id: 'overview', title: 'Overview', icon: 'home',
  create({ view }) {
    let lists = null;
    async function load() {
      const [o, l] = await Promise.all([get('/api/overview'), lists ? Promise.resolve(lists) : get('/api/lists')]);
      lists = l;
      const stage = Object.fromEntries(o.stages.map(s => [s.stage, s.n]));
      const total = o.stages.reduce((a, s) => a + s.n, 0);
      const connected = o.numbers.filter(n => n.state === 'open').length;
      const w = o.workers || {};
      const run = o.lastRun;
      view.innerHTML = `<div class="page">
        <div class="grid k4">
          <a class="card kpi" href="#/numbers"><div class="n">${connected}<span class="muted" style="font-size:16px"> / ${o.numbers.length}</span></div><div class="l">WhatsApp numbers connected</div></a>
          <a class="card kpi" href="#/today"><div class="n">${o.sentToday}</div><div class="l">Automatic messages sent today</div></a>
          <a class="card kpi" href="#/alerts/replies"><div class="n">${o.repliesToday.n}</div><div class="l">Reseller replies today (${o.repliesToday.groups} group${o.repliesToday.groups === 1 ? '' : 's'})</div></a>
          <a class="card kpi" href="#/alerts"><div class="n" style="color:${o.openAlerts ? 'var(--danger)' : 'inherit'}">${o.openAlerts}</div><div class="l">Replies waiting for a person</div></a>
          <a class="card kpi" href="#/attention"><div class="n" style="color:${o.bindIssues + o.needsStatus ? 'var(--warn)' : 'inherit'}">${o.bindIssues + o.needsStatus}</div><div class="l">Groups that need a person</div></a>
        </div>
        <h2 class="sec">${icon('phone', 'sm')} Numbers</h2>
        <div class="grid k4">${o.numbers.map(n => `
          <a class="card kpi" href="#/chats/${encodeURIComponent(n.instance)}" style="text-decoration:none;color:inherit">
            <div class="row"><span class="chip-n" style="background:${numberColor(n)}">${esc(n.role)}</span><b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.label)}</b></div>
            <div class="row small" style="margin-top:8px"><span class="dot ${esc(n.state)}"></span>${esc(stateLabel(n.state))}</div>
            <div class="small muted" style="margin-top:4px">${n.phone ? `+${esc(n.phone)}` : 'not linked'} · ${n.groups} groups${n.role === 'sender' ? ` · slice ${n.slice}` : ''}</div>
          </a>`).join('')}
          <button class="card kpi" data-add style="border-style:dashed;background:transparent;cursor:pointer;color:var(--text-2)">${icon('plus')}<div class="l">Add WhatsApp</div></button>
        </div>
        <div class="grid k2" style="margin-top:16px">
          <div class="card"><div class="hd"><h3>Today</h3><span class="spacer"></span><a class="btn sm primary" href="#/today">Open today's preview</a></div>
            <div class="bd kv">
              <div>Date</div><div>${esc(niceDate(o.today))}</div>
              <div>Follow-up ring</div><div>batch ${o.batches.follow_up} of ${o.batches.ringLen}${o.batches.follow_up_ran_today ? ' <span class="pill ok">ran today</span>' : ''}</div>
              <div>Offer ring</div><div>batch ${o.batches.offer} of ${o.batches.ringLen}${o.batches.offer_ran_today ? ' <span class="pill ok">ran today</span>' : ''}</div>
              <div>Last run</div><div>${run ? `#${run.id} · ${esc(run.status)} · ${run.sent}/${run.total} sent · ${esc(dateTime(run.created_at))}${run.stop_reason ? `<div class="small muted">${esc(run.stop_reason)}</div>` : ''}` : 'none yet'}</div>
            </div></div>
          <div class="card"><div class="hd"><h3>Resellers</h3><span class="spacer"></span><a class="btn sm" href="#/resellers">Open</a></div>
            <div class="bd">${total ? STAGE_ORDER.filter(s => stage[s]).map(s => `
              <div class="row" style="margin:6px 0"><span style="width:150px" class="small">${esc(lists.stages[s] || s)}</span>
                <div class="progress" style="flex:1"><i style="width:${Math.round((stage[s] / total) * 100)}%"></i></div><b style="width:40px;text-align:right">${stage[s]}</b></div>`).join('')
              : '<div class="muted">No resellers yet. Import leads on the Resellers page.</div>'}</div></div>
        </div>
        <h2 class="sec">Background jobs</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Job</th><th>What it does</th><th>Last finished</th><th>State</th></tr></thead><tbody>
          ${[['read', 'Every 3 minutes: finds new groups, binds them, reads every group, sets statuses, catches replies'],
            ['sender', 'Every 5 seconds: sends the approved queue, one message at a time per number'],
            ['alerts', 'Every minute: tells owners about replies until they acknowledge'],
            ['day-close', 'After 17:30: closes a day with nothing to send so the rings move on']].map(([k, d]) => `
            <tr><td><b>${k}</b></td><td class="small">${d}</td><td class="small">${w[k]?.lastOk ? esc(ago(w[k].lastOk)) : '—'}</td>
              <td>${w[k]?.lastError ? `<span class="pill bad" title="${esc(w[k].lastError)}">error</span> <span class="small muted">${esc(w[k].lastError.slice(0, 90))}</span>` : w[k]?.lastOk ? '<span class="pill ok">ok</span>' : '<span class="pill">waiting</span>'}</td></tr>`).join('')}
        </tbody></table></div>
      </div>`;
      view.querySelector('[data-add]').onclick = () => openAddWhatsApp(() => load());
    }
    return { load, refresh: load, refreshMs: 20000 };
  },
};
