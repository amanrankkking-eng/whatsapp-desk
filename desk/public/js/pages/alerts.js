// Stage 11: replies that wait for a person, and the day-by-day replies tracker for every group.
import { get, post, esc, icon, toast, fail, dateTime, ago, time, niceDate, numbersList, numberChip } from '../core.js';

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export default {
  id: 'alerts', title: 'Replies & alerts', icon: 'bell',
  create({ view, args }) {
    let tab = args[0] === 'replies' ? 'replies' : args[0] === 'all' ? 'all' : 'open', day = istToday(), numbers = [];
    const numberOf = i => numbers.find(n => n.instance === i);
    const KIND = { reply: ['Replied', 'info'], stop: ['Asked to stop', 'bad'], left: ['Left the group', 'warn'] };

    async function renderAlerts() {
      const list = await get(`/api/alerts?show=${tab === 'all' ? 'all' : 'open'}`);
      return list.length ? list.map(a => `<div class="card" style="margin-top:10px"><div class="bd">
          <div class="row wrap"><span class="pill ${KIND[a.kind]?.[1] || ''}">${esc(KIND[a.kind]?.[0] || a.kind)}</span>
            <b><a href="#/resellers/${a.reseller_id}">${esc(a.name || a.code)}</a></b><span class="pill">${esc(a.code)}</span>
            <span class="small muted">${esc(a.group_name || '')}</span><span class="spacer"></span>
            <span class="small">Owner: <b>${esc(a.owner_name || 'none set')}</b></span></div>
          <div style="margin:8px 0;white-space:pre-wrap;padding:8px 10px;border-left:4px solid var(--accent);background:var(--panel-2);border-radius:6px">${esc(a.text || '')}</div>
          <div class="row wrap small muted">${a.count > 1 ? `${a.count} messages · ` : ''}first ${esc(dateTime(a.first_at))} · last ${esc(ago(a.last_at))}
            · told the owner ${a.notify_count} time${a.notify_count === 1 ? '' : 's'}${a.acked_at ? ` · acknowledged by <b>${esc(a.acked_by || '')}</b> ${esc(dateTime(a.acked_at))}` : ''}
            <span class="spacer"></span>
            ${a.instance && a.jid ? `<a class="btn sm" href="#/chats/${encodeURIComponent(a.instance)}/${encodeURIComponent(a.jid)}">${icon('chat', 'sm')} Answer in the chat</a>` : ''}
            ${a.acked_at ? '' : `<button class="btn sm primary" data-ack="${a.id}">Acknowledge</button>`}</div>
        </div></div>`).join('')
        : `<div class="card"><div class="empty">${tab === 'open' ? 'No reply is waiting. Every reply from a reseller pauses that group and shows up here until someone acknowledges it.' : 'No alerts yet.'}</div></div>`;
    }
    async function renderReplies() {
      const d = await get(`/api/replies?day=${day}`);
      const total = d.groups.reduce((a, g) => a + g.replies, 0);
      return `<div class="row wrap" style="margin-bottom:10px"><label class="f" style="grid-auto-flow:column;align-items:center">Day <input class="in sm" type="date" data-day value="${esc(day)}" max="${istToday()}" style="width:auto"></label>
          <span class="small muted">${total} messages from other people in ${d.groups.filter(g => g.replies).length} groups on ${esc(niceDate(day))}</span>
          <span class="spacer"></span><a class="btn sm" href="/api/export/replies.csv">${icon('download', 'sm')} All reseller replies (CSV)</a></div>
        ${d.groups.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Group</th><th class="num">Their messages</th><th class="num">Ours</th><th>Last from them</th><th>Numbers</th></tr></thead><tbody>
          ${d.groups.map(g => `<tr class="click" data-open="${esc(g.instances[0])}|${esc(g.jid)}"><td><b>${esc(g.name)}</b>${g.reseller ? ` <span class="pill accent">${esc(g.reseller.code)}</span>` : ''}</td>
            <td class="num"><b>${g.replies}</b></td><td class="num">${g.ours}</td>
            <td class="small">${g.last_ts ? `${esc(time(g.last_ts))} · ` : ''}${esc(g.lastText || '')}</td>
            <td>${g.instances.map(i => numberChip(numberOf(i))).join(' ')}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="card"><div class="empty">No group messages on this day.</div></div>'}`;
    }
    async function render() {
      numbers = await numbersList();
      const body = tab === 'replies' ? await renderReplies() : await renderAlerts();
      view.innerHTML = `<div class="page">
        <div class="tabs"><button data-tab="open" class="${tab === 'open' ? 'on' : ''}">Waiting for a person</button>
          <button data-tab="all" class="${tab === 'all' ? 'on' : ''}">All alerts</button>
          <button data-tab="replies" class="${tab === 'replies' ? 'on' : ''}">Replies by day</button></div>
        ${tab !== 'replies' ? '<div class="note small" style="margin-bottom:6px">The desk never answers anyone. A person answers in the chat, then acknowledges here and marks the row on the reseller page when the conversation is over.</div>' : ''}
        ${body}</div>`;
      view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { location.hash = `#/alerts/${b.dataset.tab}`; });
      view.querySelectorAll('[data-ack]').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try { await post(`/api/alerts/${b.dataset.ack}/ack`); toast('Acknowledged', 'ok'); await render(); } catch (e) { fail(e); b.disabled = false; }
      });
      view.querySelector('[data-day]')?.addEventListener('change', e => { day = e.target.value || istToday(); render().catch(fail); });
      view.querySelectorAll('[data-open]').forEach(tr => tr.onclick = () => { const [i, j] = tr.dataset.open.split('|'); location.hash = `#/chats/${encodeURIComponent(i)}/${encodeURIComponent(j)}`; });
    }
    return {
      load: render, refresh: render, refreshMs: 20000,
      onArgs(a) { tab = a[0] === 'replies' ? 'replies' : a[0] === 'all' ? 'all' : 'open'; render().catch(fail); },
    };
  },
};
