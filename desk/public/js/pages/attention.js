// Everything the automation could not decide by itself and hands to a person.
import { get, post, esc, icon, toast, fail, modal, dateTime, numbersList } from '../core.js';

export default {
  id: 'attention', title: 'Needs a person', icon: 'alert',
  create({ view }) {
    let showIgnored = false;
    async function render() {
      const [issues, rows, rejects, numbers] = await Promise.all([get('/api/bind-issues'), get('/api/resellers'), get('/api/lead-rejects'), numbersList()]);
      const open = issues.filter(i => showIgnored || !i.ignored);
      const needs = rows.filter(r => r.group_jid && !r.track && r.stage === 'live' && !r.paused && !r.hold && !r.dnc);
      const unreadable = rows.filter(r => r.group_jid && r.readable === false && !['dnc', 'invalid', 'active_reseller'].includes(r.stage));
      const noGroup = rows.filter(r => !r.group_jid && ['live', 'offer_sent', 'called_1'].includes(r.stage));
      // 13: every group has exactly one named owner, who gets its alerts.
      const noOwner = rows.filter(r => r.group_jid && !r.owner_id && !['active_reseller', 'not_interested', 'dnc', 'exhausted', 'invalid'].includes(r.stage));
      view.innerHTML = `<div class="page">
        <h2 class="sec" style="margin-top:0">${icon('group', 'sm')} Groups that could not be bound <span class="badge ${open.length ? 'red' : 'grey'}">${open.length}</span>
          <span class="spacer"></span><label class="check small"><input type="checkbox" data-ign ${showIgnored ? 'checked' : ''}> show ignored</label></h2>
        <div class="note small">A group is bound to a reseller only when exactly one member's phone matches exactly one reseller and exactly one sender number is in it.
          The group name is never used to match. Anything else is listed here.</div>
        ${open.length ? open.map(i => `<div class="card" style="margin-top:10px"><div class="bd row wrap top">
          <div style="flex:1;min-width:220px"><b>${esc(i.detail?.subject || i.jid)}</b>${i.ignored ? ' <span class="pill">ignored</span>' : ''}
            <div class="small">${esc(i.reason)}</div>
            ${i.detail?.phones?.length ? `<div class="small muted">Members: ${i.detail.phones.map(p => `+${esc(p)}`).join(', ')}</div>` : ''}
            <div class="small muted">Seen ${esc(dateTime(i.seen_at))}</div></div>
          <div class="row wrap"><button class="btn sm primary" data-bind="${esc(i.jid)}">Bind to a reseller…</button>
            <button class="btn sm" data-ignore="${esc(i.jid)}" data-v="${i.ignored ? '0' : '1'}">${i.ignored ? 'Stop ignoring' : 'Ignore'}</button></div>
        </div></div>`).join('') : '<div class="card" style="margin-top:10px"><div class="empty">Nothing to bind by hand.</div></div>'}

        <h2 class="sec">${icon('today', 'sm')} In the loop but no status <span class="badge ${needs.length ? 'red' : 'grey'}">${needs.length}</span></h2>
        ${needs.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${needs.map(r => `<tr><td><a href="#/resellers/${r.id}">${esc(r.name || r.code)}</a> <span class="small muted">${esc(r.code)}</span></td>
          <td class="small">${esc(r.track_reason || '')}</td><td class="nowrap"><button class="btn sm" data-track="follow_up" data-id="${r.id}">Follow-up</button> <button class="btn sm" data-track="offer" data-id="${r.id}">Offer</button></td></tr>`).join('')}</tbody></table></div>`
          : '<div class="card"><div class="empty">Every group in the loop has a status.</div></div>'}

        <h2 class="sec">${icon('alert', 'sm')} Groups that cannot be read <span class="badge grey">${unreadable.length}</span></h2>
        <div class="note small">An empty read means unknown, never quiet. Send the first offer into the group by hand; that gives it a readable history.</div>
        ${unreadable.length ? `<div class="tbl-wrap" style="margin-top:8px"><table class="tbl"><tbody>${unreadable.map(r => `<tr><td><a href="#/resellers/${r.id}">${esc(r.name || r.code)}</a></td>
          <td><a class="btn sm" href="#/chats/${encodeURIComponent(r.instance || '')}/${encodeURIComponent(r.group_jid)}">Open the chat</a></td></tr>`).join('')}</tbody></table></div>` : ''}

        <h2 class="sec">${icon('user', 'sm')} Groups without an owner <span class="badge ${noOwner.length ? 'red' : 'grey'}">${noOwner.length}</span></h2>
        <div class="note small">Every group needs one named owner: their replies alert that person by name. Without one, alerts go to the team space as "No owner set".</div>
        ${noOwner.length ? `<div class="tbl-wrap" style="margin-top:8px"><table class="tbl"><tbody>${noOwner.map(r => `<tr><td><a href="#/resellers/${r.id}">${esc(r.name || r.code)}</a> <span class="small muted">${esc(r.code)}</span></td>
          <td class="small">${esc(r.group_name || '')}</td><td class="nowrap"><a class="btn sm" href="#/resellers/${r.id}">Set the owner</a></td></tr>`).join('')}</tbody></table></div>` : ''}

        <h2 class="sec">Resellers with no group yet <span class="badge grey">${noGroup.length}</span></h2>
        ${noGroup.length ? `<div class="tbl-wrap"><table class="tbl"><tbody>${noGroup.map(r => `<tr><td><a href="#/resellers/${r.id}">${esc(r.name || r.code)}</a> <span class="small muted">${esc(r.code)} · +${esc(r.phone)}</span></td>
          <td class="small">Create the group, name it with ${esc(r.code)}, add the reader and one sender, then send the first offer by hand.</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="card"><div class="empty">None.</div></div>'}

        <h2 class="sec">Rejected leads <span class="badge grey">${rejects.length}</span></h2>
        ${rejects.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Row</th><th>Why</th></tr></thead><tbody>${rejects.slice(0, 100).map(x => `<tr><td class="small nowrap">${esc(dateTime(x.created_at))}</td>
          <td class="small">${esc([x.raw?.name, x.raw?.phone].filter(Boolean).join(' · '))}</td><td class="small">${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="card"><div class="empty">None.</div></div>'}
      </div>`;
      view.querySelector('[data-ign]').onchange = e => { showIgnored = e.target.checked; render().catch(fail); };
      view.querySelectorAll('[data-ignore]').forEach(b => b.onclick = async () => {
        try { await post('/api/bind-issues/ignore', { jid: b.dataset.ignore, ignored: b.dataset.v === '1' }); await render(); } catch (e) { fail(e); }
      });
      view.querySelectorAll('[data-track]').forEach(b => b.onclick = async () => {
        try { await post(`/api/resellers/${b.dataset.id}/track`, { track: b.dataset.track }); toast('Status set', 'ok'); await render(); } catch (e) { fail(e); }
      });
      view.querySelectorAll('[data-bind]').forEach(b => b.onclick = async () => {
        const jid = b.dataset.bind;
        const groups = (await get('/api/groups?instance=all')).filter(g => g.jid === jid && g.role === 'sender' && !g.left_group);
        const free = rows.filter(r => !r.group_jid && !['invalid', 'dnc'].includes(r.stage));
        if (!groups.length) return toast('No sender number is in this group. Add one sender to it first.', 'bad');
        const c = modal({ title: 'Bind the group by hand', body: `<div class="stack">
            <label class="f"><span>Reseller</span><select class="in" data-r>${free.map(r => `<option value="${r.id}">${esc(r.code)} · ${esc(r.name)} · +${esc(r.phone)}</option>`).join('')}</select></label>
            <label class="f"><span>Sender number that owns it</span><select class="in" data-n>${groups.map(g => `<option value="${esc(g.instance)}">${esc(numbers.find(n => n.instance === g.instance)?.label || g.instance)}</option>`).join('')}</select></label>
            ${groups.length > 1 ? '<div class="note warn small">More than one sender is in this group. Remove the extra sender from the group on the phone so only the owner stays.</div>' : ''}</div>`,
          actions: [{ label: 'Cancel' }, { label: 'Bind', kind: 'primary', onClick: async () => {
            await post(`/api/resellers/${c.body.querySelector('[data-r]').value}/bind`, { instance: c.body.querySelector('[data-n]').value, jid });
            toast('Bound', 'ok'); await render();
          } }] });
        if (!free.length) { c.close(); toast('Every reseller already has a group. Add the reseller first.', 'bad'); }
      });
    }
    return { load: render, refresh: render, refreshMs: 30000 };
  },
};
