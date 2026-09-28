// Stage 7: the whole day as a preview. Nothing sends until a person approves the named list.
import { get, post, esc, icon, toast, fail, modal, confirmBox, waFormat, time, dateTime, niceDate, plural, numbersList, numberChip } from '../core.js';

export default {
  id: 'today', title: "Today's sends", icon: 'today',
  create({ view }) {
    let data = null, numbers = [], picked = null, runDetail = null;
    const numberOf = i => numbers.find(n => n.instance === i);

    function laneCards(p) {
      return `<div class="grid k4">${p.senders.map(s => `
        <div class="card lane"><div class="t">${numberChip(numberOf(s.instance)) || esc(s.label)} <span class="dot ${esc(s.state)}"></span></div>
          <div class="small muted" style="margin-top:6px">${s.planned} ready${s.queued ? ` · ${s.queued} in the run` : ''} · ${s.sentToday} sent today · cap ${s.cap}</div>
          <div class="progress" style="margin-top:8px"><i style="width:${Math.min(100, Math.round(((s.sentToday + s.planned + s.queued) / Math.max(1, s.cap)) * 100))}%"></i></div></div>`).join('')
        || '<div class="note warn">No sender number yet.</div>'}</div>`;
    }
    function itemCard(i) {
      const on = picked.has(i.id);
      return `<div class="item" data-item="${i.id}">
        <div class="top"><label class="check" style="margin-top:2px"><input type="checkbox" data-pick="${i.id}" ${on ? 'checked' : ''} aria-label="Include ${esc(i.name)}"></label>
          <div class="grow">
            <div class="row wrap"><b>${esc(i.name || i.code)}</b><span class="pill">${esc(i.code)}</span>
              <span class="pill ${i.ring === 'offer' ? 'info' : 'ok'}">${i.ring === 'offer' ? 'Offer' : 'Follow-up'} · ${esc(i.rungLabel)}</span>
              ${numberChip(numberOf(i.instance))}<span class="small muted">at ${esc(time(i.scheduledAt))}</span></div>
            <div class="small" style="margin-top:3px">${icon('group', 'sm')} ${esc(i.group || i.jid)} · owner ${esc(i.owner || 'none')}
              · tag: ${i.tag ? `@${esc(i.tag.phone)} <span class="muted">(${esc(i.tag.why)})</span>` : '<span class="muted">nobody safe to tag - goes untagged</span>'}
              ${i.intro ? ' · <span class="pill warn">opens with the new-sender intro</span>' : ''}</div>
            <div class="why">Why: ${esc(i.why)}</div>
          </div>
          <a class="icon-btn" href="#/chats/${encodeURIComponent(i.instance)}/${encodeURIComponent(i.jid)}" title="Open the chat">${icon('chat')}</a></div>
        <div class="text"><div class="wa-preview"><div class="m sent first"><div class="bub"><span class="txt">${waFormat(i.text)}</span><span class="meta">${esc(time(i.scheduledAt))}</span></div></div></div></div>
      </div>`;
    }
    function listSection(title, rows, fmt, open = false) {
      if (!rows.length) return '';
      return `<details class="card" ${open ? 'open' : ''} style="margin-top:12px"><summary class="hd" style="cursor:pointer;list-style:none"><h3>${esc(title)}</h3><span class="badge grey">${rows.length}</span></summary>
        <div class="bd"><div class="tbl-wrap"><table class="tbl"><tbody>${rows.map(fmt).join('')}</tbody></table></div></div></details>`;
    }
    const link = r => `<a href="#/resellers/${r.id}">${esc(r.name || r.code)}</a> <span class="muted small">${esc(r.code)}</span>`;

    function render() {
      const p = data.plan;
      const run = data.running;
      if (!picked) picked = new Set(p.items.map(i => i.id));
      for (const id of [...picked]) if (!p.items.some(i => i.id === id)) picked.delete(id);
      const byCheck = {};
      for (const s of p.skips) (byCheck[s.check || 'not in the loop today'] ||= []).push(s);
      view.innerHTML = `<div class="page">
        <div class="row wrap" style="margin-bottom:12px">
          <div><div style="font-size:18px;font-weight:600">${esc(niceDate(p.day))}, ${esc(p.weekday)}</div>
            <div class="small muted">Follow-up ring batch ${p.batches.follow_up} · offer ring batch ${p.batches.offer} · ring of ${p.batches.ringLen} batches
              ${p.batches.follow_up_ran_today ? ' · <span class="pill ok">today\'s batches already ran</span>' : ''}</div></div>
          <span class="spacer"></span><button class="btn sm" data-reload>${icon('refresh', 'sm')} Recheck now</button></div>
        ${p.notes.map(n => `<div class="note warn" style="margin-bottom:10px">${esc(n)}</div>`).join('')}
        ${laneCards(p)}
        ${run ? `<div class="card" style="margin-top:14px"><div class="hd"><h3>Sending now — run #${run.id}</h3><span class="spacer"></span>
            <button class="btn sm danger" data-stop>${icon('stop', 'sm')} Stop the run</button></div><div class="bd" data-run>Loading…</div></div>` : ''}
        ${data.todayRuns.filter(r => !run || r.id !== run.id).map(r => `<div class="note ${r.status === 'stopped' ? 'warn' : 'ok'} small" style="margin-top:10px">
            Run #${r.id} today: ${esc(r.status)}${r.stop_reason ? ` — ${esc(r.stop_reason)}` : ''} (approved by ${esc(r.approved_by || '—')}, ${esc(time(r.created_at))}) · <a href="#/reports/run/${r.id}">details</a></div>`).join('')}
        <h2 class="sec">${icon('send', 'sm')} Ready to send <span class="badge ${p.items.length ? '' : 'grey'}">${p.items.length}</span></h2>
        ${p.items.length ? `<div class="help" style="margin:-4px 0 6px">Every message below goes exactly as shown, from the number shown, one at a time per number, with 5–14 minute random gaps.</div>
          <div class="row small" style="margin:0 0 10px"><button class="btn sm ghost" data-all>Select all</button><button class="btn sm ghost" data-none>Select none</button></div>
          ${p.items.map(itemCard).join('')}`
          : `<div class="card"><div class="empty">${!p.isSendDay ? 'Not a send day.' : run ? 'Everything approved today is in the run above.' : 'Nothing to send right now.'}
              ${p.isSendDay && !run && !data.todayRuns.length ? '<div style="margin-top:10px"><button class="btn sm" data-close>Close the day (moves both rings on)</button></div>' : ''}</div></div>`}
        ${p.skips.length ? `<h2 class="sec">${icon('alert', 'sm')} Skipped today <span class="badge grey">${p.skips.length}</span></h2>
          <div class="note small" style="margin-bottom:10px">A skipped group is never dropped. It waits for its ring's next turn.</div>
          ${Object.entries(byCheck).map(([check, rows]) => `<div class="card" style="margin-top:10px"><div class="hd"><h3>${esc(check)}</h3><span class="badge grey">${rows.length}</span></div>
            <div class="bd"><div class="tbl-wrap"><table class="tbl"><tbody>${rows.map(s => `<tr><td>${link(s)}</td><td class="small">${esc(s.reason)}</td><td class="small muted">${esc(s.ring || '')}</td></tr>`).join('')}</tbody></table></div></div></div>`).join('')}` : ''}
        ${listSection('Needs a status from a person', p.needsStatus, r => `<tr><td>${link(r)}</td><td class="small">${esc(r.reason || '')}</td>
            <td class="nowrap"><button class="btn sm" data-track="follow_up" data-id="${r.id}">Follow-up</button> <button class="btn sm" data-track="offer" data-id="${r.id}">Offer</button></td></tr>`, true)}
        ${listSection('Paused — a person is handling the conversation', p.paused, r => `<tr><td>${link(r)}</td><td class="small">${esc(r.reason || '')}</td><td class="small muted">${esc(dateTime(r.since))}</td></tr>`)}
        ${listSection('Every message used — exhausted', p.exhausted, r => `<tr><td>${link(r)}</td><td class="small">${esc(r.ring)}: add a new message to bring it back</td></tr>`)}
        ${listSection('Due tomorrow', p.dueTomorrow, r => `<tr><td>${link(r)}</td><td class="small">${esc(r.ring || '')}</td></tr>`)}
        ${listSection('Waiting for their turn', p.waiting, r => `<tr><td>${link(r)}</td><td class="small">${r.days == null ? 'never messaged' : `${plural(r.days, 'day')} since our last message`}</td><td class="small muted">${r.next ? `next turn ${esc(niceDate(r.next))}` : ''}</td></tr>`)}
        ${p.items.length ? `<div class="sticky-actions"><b data-count></b><span class="small muted hide-sm">Nothing goes out until you approve.</span><span class="spacer"></span>
          <button class="btn primary" data-approve>${icon('send', 'sm')} Approve and send</button></div>` : ''}
      </div>`;
      bind();
      updateCount();
      if (run) loadRun();
    }
    function updateCount() {
      const c = view.querySelector('[data-count]');
      if (c) c.textContent = `${picked.size} of ${data.plan.items.length} selected`;
    }
    function bind() {
      view.querySelector('[data-reload]').onclick = () => load().catch(fail);
      view.querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => { const id = Number(cb.dataset.pick); cb.checked ? picked.add(id) : picked.delete(id); updateCount(); });
      view.querySelector('[data-all]')?.addEventListener('click', () => { picked = new Set(data.plan.items.map(i => i.id)); render(); });
      view.querySelector('[data-none]')?.addEventListener('click', () => { picked = new Set(); render(); });
      view.querySelectorAll('[data-track]').forEach(b => b.onclick = async () => {
        try { await post(`/api/resellers/${b.dataset.id}/track`, { track: b.dataset.track }); toast('Status set'); await load(); } catch (e) { fail(e); }
      });
      view.querySelector('[data-stop]')?.addEventListener('click', async () => {
        if (!await confirmBox('Stop the run', 'Everything still queued is cancelled. The ring counters do not move, so the same batch comes round again on the next send day.', { ok: 'Stop', danger: true })) return;
        try { await post(`/api/runs/${data.running.id}/stop`); toast('Run stopped'); await load(); } catch (e) { fail(e); }
      });
      view.querySelector('[data-close]')?.addEventListener('click', async () => {
        if (!await confirmBox('Close the day', 'Nothing is due today. Closing the day moves both ring counters on by one, as if the batch ran. It also closes on its own after the sending window ends.', { ok: 'Close the day' })) return;
        try { await post('/api/today/approve', { ids: [] }); toast('Day closed'); await load(); } catch (e) { fail(e); }
      });
      view.querySelector('[data-approve]')?.addEventListener('click', approve);
    }
    function approve() {
      const items = data.plan.items.filter(i => picked.has(i.id));
      const dropped = data.plan.items.length - items.length;
      const c = modal({
        title: items.length ? `Approve ${plural(items.length, 'message')}` : 'Approve with nothing selected', wide: true,
        body: items.length ? `<p style="margin-top:0">These groups will get the exact text shown on the page:</p>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Reseller</th><th>Group</th><th>From</th><th>Message</th><th>At</th></tr></thead><tbody>
          ${items.map(i => `<tr><td>${esc(i.name || i.code)} <span class="muted small">${esc(i.code)}</span></td><td class="small">${esc(i.group)}</td><td>${numberChip(numberOf(i.instance))}</td><td class="small">${esc(i.rungLabel)}</td><td class="small">${esc(time(i.scheduledAt))}</td></tr>`).join('')}
          </tbody></table></div>
          ${dropped ? `<div class="note warn small" style="margin-top:10px">${plural(dropped, 'group')} left unticked will not be sent today and wait for their next turn.</div>` : ''}
          <div class="help" style="margin-top:10px">Every group is checked again at the moment of sending. If anything changed (a reply, a hold, the sender disconnected), that group is skipped. The first error stops the whole run.</div>`
          : '<p style="margin-top:0">Nothing is selected. Approving closes today with no messages; every group in today\'s batches waits for its next turn.</p>',
        actions: [{ label: 'Cancel' }, { label: items.length ? `Approve and send ${items.length}` : 'Close today', kind: 'primary', onClick: async () => {
          const r = await post('/api/today/approve', { ids: items.map(i => i.id) });
          toast(r.queued ? `Run #${r.runId}: ${plural(r.queued, 'message')} queued` : 'Day closed', 'ok');
          if (r.dropped?.length) toast(`${plural(r.dropped.length, 'group')} no longer passed the checks and were left out`, 'bad');
          picked = null;
          await load();
        } }],
      });
      void c;
    }
    async function loadRun() {
      const box = view.querySelector('[data-run]');
      if (!box || !data.running) return;
      runDetail = await get(`/api/runs/${data.running.id}`);
      const s = runDetail.sends;
      const done = s.filter(x => x.status === 'sent').length;
      const next = s.filter(x => x.status === 'queued').sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
      box.innerHTML = `<div class="row small" style="margin-bottom:8px"><b>${done} of ${s.length} sent</b><span class="spacer"></span>${next ? `next at ${esc(time(next.scheduled_at))}` : ''}</div>
        <div class="progress"><i style="width:${Math.round((done / Math.max(1, s.length)) * 100)}%"></i></div>
        <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>At</th><th>Reseller</th><th>From</th><th>Message</th><th>Status</th></tr></thead><tbody>
        ${s.map(x => `<tr><td class="small nowrap">${esc(time(x.sent_at || x.scheduled_at))}</td><td>${esc(x.name || x.code || '')}</td><td>${numberChip(numberOf(x.instance)) || esc(x.sender_label || '')}</td>
          <td class="small">${esc(x.rung_label)}</td><td>${x.status === 'sent' ? '<span class="pill ok">sent</span>' : x.status === 'queued' ? '<span class="pill">waiting</span>' : x.status === 'sending' ? '<span class="pill info">sending</span>'
            : `<span class="pill ${x.status === 'failed' ? 'bad' : 'warn'}" title="${esc(x.error || '')}">${esc(x.status)}</span> <span class="small muted">${esc((x.error || '').slice(0, 80))}</span>`}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    async function load() {
      [data, numbers] = await Promise.all([get('/api/today'), numbersList()]);
      render();
    }
    return {
      load,
      async refresh() {
        // While sending, only the run box updates; the list stays as the person left it.
        const fresh = await get('/api/today');
        const changed = !!fresh.running !== !!data.running || fresh.plan.items.map(i => i.id).join() !== data.plan.items.map(i => i.id).join()
          || fresh.todayRuns.map(r => r.status).join() !== data.todayRuns.map(r => r.status).join();
        data = fresh;
        if (changed) render(); else if (data.running) await loadRun();
      },
      refreshMs: 15000,
    };
  },
};
