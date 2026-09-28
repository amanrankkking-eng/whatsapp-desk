// Stage 9: the team summaries and owner briefs, and every run with its sends and skips.
import { get, post, esc, icon, toast, fail, dateTime, time, niceDate, numbersList, numberChip } from '../core.js';

export default {
  id: 'reports', title: 'Reports', icon: 'report',
  create({ view, args }) {
    let tab = args[0] === 'run' ? 'runs' : args[0] || 'summaries', runId = args[0] === 'run' ? Number(args[1]) : null, numbers = [];
    const numberOf = i => numbers.find(n => n.instance === i);
    async function render() {
      numbers = await numbersList();
      let body = '';
      if (tab === 'summaries') {
        const reps = await get('/api/reports');
        body = reps.length ? reps.map(r => `<div class="card" style="margin-top:10px"><div class="hd"><h3>${esc(r.title || r.kind)}</h3>
            <span class="pill ${r.kind === 'team' ? 'accent' : ''}">${r.kind === 'team' ? 'team chat' : `brief for ${esc(r.owner_name || '')}`}</span><span class="spacer"></span>
            ${r.posted_at ? `<span class="pill ok">posted ${esc(time(r.posted_at))}</span>` : `<span class="pill warn" title="${esc(r.post_error || '')}">not posted: ${esc(r.post_error || '')}</span>`}</div>
          <div class="bd" style="white-space:pre-wrap;font-size:13.4px">${esc(r.body)}</div></div>`).join('')
          : '<div class="card"><div class="empty">The first summary is written after the first run. It goes to the team chat space set on the Settings page.</div></div>';
      } else if (runId) {
        const d = await get(`/api/runs/${runId}`);
        body = `<div class="row" style="margin-bottom:10px"><a class="btn sm" href="#/reports/runs">${icon('back', 'sm')} All runs</a></div>
          <div class="card"><div class="hd"><h3>Run #${d.run.id} · ${esc(niceDate(d.run.day))}</h3><span class="pill">${esc(d.run.status)}</span><span class="spacer"></span>
            <button class="btn sm" data-rebuild="${d.run.id}">Post the summary again</button></div>
            <div class="bd kv"><div>Approved by</div><div>${esc(d.run.approved_by || '—')} · ${esc(dateTime(d.run.created_at))}</div>
              <div>Batches</div><div>follow-up ${d.run.fu_batch} · offer ${d.run.of_batch} (ring of ${d.run.ring_len})</div>
              <div>Finished</div><div>${esc(dateTime(d.run.finished_at))}${d.run.stop_reason ? ` — ${esc(d.run.stop_reason)}` : ''}</div></div></div>
          <h2 class="sec">Messages</h2>
          ${d.sends.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>At</th><th>Reseller</th><th>Group</th><th>From</th><th>Message</th><th>Tagged</th><th>Status</th></tr></thead><tbody>
            ${d.sends.map(s => `<tr><td class="small nowrap">${esc(time(s.sent_at || s.scheduled_at))}</td><td>${esc(s.name || s.code || '')}</td><td class="small">${esc(s.group_name || '')}</td>
              <td>${numberChip(numberOf(s.instance)) || esc(s.sender_label || '')}</td><td class="small">${esc(s.rung_label)}</td><td class="small">${s.tagged ? `@${esc(s.tagged)}` : '—'}</td>
              <td><span class="pill ${s.status === 'sent' ? 'ok' : s.status === 'failed' ? 'bad' : ''}" title="${esc(s.error || '')}">${esc(s.status)}</span></td></tr>`).join('')}</tbody></table></div>`
            : '<div class="card"><div class="empty">No messages in this run.</div></div>'}
          <h2 class="sec">Skipped</h2>
          ${d.skips.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${d.skips.map(k => `<tr><td>${esc(k.name || k.code || '')}</td><td class="small">${esc(k.reason)}</td></tr>`).join('')}</tbody></table></div>`
            : '<div class="card"><div class="empty">Nothing skipped.</div></div>'}`;
      } else {
        const runs = await get('/api/runs');
        body = runs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Run</th><th>Day</th><th>Status</th><th class="num">Sent</th><th class="num">Skipped</th><th>Approved by</th><th>Note</th></tr></thead><tbody>
          ${runs.map(r => `<tr class="click" data-run="${r.id}"><td>#${r.id}</td><td class="nowrap">${esc(niceDate(r.day))}</td><td><span class="pill ${r.status === 'done' ? 'ok' : r.status === 'stopped' ? 'warn' : 'info'}">${esc(r.status)}</span></td>
            <td class="num">${r.sent}/${r.total}</td><td class="num">${r.skipped}</td><td class="small">${esc(r.approved_by || '')}</td><td class="small">${esc(r.stop_reason || '')}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="card"><div class="empty">No runs yet.</div></div>';
      }
      view.innerHTML = `<div class="page"><div class="tabs"><button data-tab="summaries" class="${tab === 'summaries' ? 'on' : ''}">Chat summaries</button>
        <button data-tab="runs" class="${tab === 'runs' ? 'on' : ''}">Runs</button><span class="spacer"></span>
        <a class="btn sm ghost" href="/api/export/sends.csv">${icon('download', 'sm')} Every send (CSV)</a></div>${body}</div>`;
      view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { location.hash = `#/reports/${b.dataset.tab}`; });
      view.querySelectorAll('[data-run]').forEach(tr => tr.onclick = () => { location.hash = `#/reports/run/${tr.dataset.run}`; });
      view.querySelector('[data-rebuild]')?.addEventListener('click', async e => {
        try { await post(`/api/reports/rebuild/${e.target.dataset.rebuild}`); toast('Summary written again', 'ok'); } catch (err) { fail(err); }
      });
    }
    return {
      load: render, refresh: render, refreshMs: 60000,
      onArgs(a) { tab = a[0] === 'run' ? 'runs' : a[0] || 'summaries'; runId = a[0] === 'run' ? Number(a[1]) : null; render().catch(fail); },
    };
  },
};
