// Stage 1 and 12: the reseller sheet. Leads in, two-tap call log, statuses, exits, binding.
import { get, post, api, esc, icon, toast, fail, modal, confirmBox, drawer, dateTime, niceDate, ago, phoneFmt, STAGE_PILL,
  numbersList, numberChip, debounce, waFormat } from '../core.js';

const ACTIONS = [
  ['resume', 'Conversation over — back in the loop', ''],
  ['hold', 'Put on hold', ''],
  ['unhold', 'Lift the hold', ''],
  ['first_offer_sent', 'Mark first offer as sent', ''],
  ['order_placed', 'Order placed (active reseller)', 'primary'],
  ['not_interested', 'Not interested', 'danger'],
  ['dnc', 'Asked to stop — do not contact', 'danger'],
  ['undo_dnc', 'Undo do-not-contact', ''],
  ['invalid', 'Wrong number / not on WhatsApp', 'danger'],
  ['reopen', 'Put back in the loop by hand', ''],
];

export default {
  id: 'resellers', title: 'Resellers', icon: 'users',
  create({ view, args, actions }) {
    let rows = [], lists = null, owners = [], numbers = [], q = '', stage = 'all', owner = 'all', openId = null, dr = null;
    actions.innerHTML = `<button class="btn" data-import>${icon('download', 'sm')} Import leads</button><button class="btn primary" data-add>${icon('plus', 'sm')} Add</button>`;
    actions.querySelector('[data-import]').onclick = openImport;
    actions.querySelector('[data-add]').onclick = openAdd;
    const numberOf = i => numbers.find(n => n.instance === i);

    function flags(r) {
      const f = [];
      if (r.dnc) f.push('<span class="pill bad">do not contact</span>');
      if (r.hold) f.push('<span class="pill warn">on hold</span>');
      if (r.paused) f.push(`<span class="pill warn" title="${esc(r.pause_reason || '')}">paused</span>`);
      if (r.left_group) f.push('<span class="pill bad">left group</span>');
      if (r.open_alerts) f.push(`<span class="pill bad">${r.open_alerts} alert</span>`);
      if (r.intro_pending) f.push('<span class="pill info">new sender</span>');
      return f.join(' ');
    }
    const track = r => (r.track ? `<span class="pill ${r.track === 'offer' ? 'info' : 'ok'}">${r.track === 'offer' ? 'Offer' : 'Follow-up'}</span> <span class="small muted">${r.track_source === 'manual' ? 'set by a person' : 'read from chat'}</span>`
      : r.group_jid ? '<span class="pill warn">needs a status</span>' : '');
    const visible = () => rows.filter(r => (stage === 'all' || r.stage === stage) && (owner === 'all' || String(r.owner_id) === owner)
      && (!q || `${r.code} ${r.name} ${r.phone} ${r.company} ${r.city} ${r.group_name || ''}`.toLowerCase().includes(q)));

    // The toolbar is drawn once; typing in the search box only redraws the table under it.
    function render() {
      if (!view.querySelector('[data-table]')) {
        view.innerHTML = `<div class="page wide">
          <div class="row wrap" style="margin-bottom:12px">
            <label class="search" style="flex:1;min-width:220px;max-width:420px">${icon('search', 'sm')}<input data-q placeholder="Search name, phone, code, group"></label>
            <select class="in sm" data-stage style="width:auto"></select>
            <select class="in sm" data-owner style="width:auto"></select>
            <span class="spacer"></span><a class="btn sm" href="/api/export/resellers.csv">${icon('download', 'sm')} Export CSV</a></div>
          <div data-table></div></div>`;
        const qi = view.querySelector('[data-q]');
        qi.oninput = debounce(() => { q = qi.value.trim().toLowerCase(); renderTable(); }, 150);
        view.querySelector('[data-stage]').onchange = e => { stage = e.target.value; renderTable(); };
        view.querySelector('[data-owner]').onchange = e => { owner = e.target.value; renderTable(); };
      }
      const counts = {};
      for (const r of rows) counts[r.stage] = (counts[r.stage] || 0) + 1;
      view.querySelector('[data-stage]').innerHTML = `<option value="all">All stages (${rows.length})</option>` +
        Object.entries(lists.stages).map(([k, l]) => `<option value="${k}" ${stage === k ? 'selected' : ''}>${esc(l)} (${counts[k] || 0})</option>`).join('');
      view.querySelector('[data-owner]').innerHTML = `<option value="all">All owners</option>` +
        owners.map(o => `<option value="${o.id}" ${owner === String(o.id) ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
      renderTable();
    }
    function renderTable() {
      const box = view.querySelector('[data-table]');
      if (!rows.length) {
        box.innerHTML = `<div class="card"><div class="empty">No resellers yet.<div style="margin-top:12px"><button class="btn primary" data-import2>Import leads</button></div></div></div>`;
        box.querySelector('[data-import2]').onclick = openImport;
        return;
      }
      const list = visible();
      box.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Reseller</th><th>Owner</th><th>Stage</th><th>Status</th><th>Sender · group</th>
          <th>Last message</th><th>Next turn</th><th>Calls</th><th></th></tr></thead><tbody>
        ${list.map(r => `<tr class="click" data-id="${r.id}">
          <td class="mono">${esc(r.code)}</td>
          <td><b>${esc(r.name || '—')}</b><div class="small muted">${esc(phoneFmt(r.phone))}${r.company ? ` · ${esc(r.company)}` : ''}${r.city ? ` · ${esc(r.city)}` : ''}</div></td>
          <td class="small">${esc(r.owner_name || '—')}</td>
          <td><span class="pill ${STAGE_PILL[r.stage] || ''}">${esc(lists.stages[r.stage] || r.stage)}</span></td>
          <td>${track(r)}</td>
          <td class="small">${r.instance ? numberChip(numberOf(r.instance)) : ''} ${esc(r.group_name || (r.group_jid ? 'group' : 'no group yet'))}</td>
          <td class="small">${r.last_msg_at ? `${r.last_msg_by === 'us' ? 'Us' : 'Reseller'}, ${esc(ago(r.last_msg_at))}` : '—'}</td>
          <td class="small nowrap">${r.next_due ? esc(niceDate(r.next_due)) : '—'}</td>
          <td class="small nowrap">${r.call1_outcome ? `1: ${esc(r.call1_outcome)}` : '<span class="muted">1: —</span>'}<br>${r.call2_outcome ? `2: ${esc(r.call2_outcome)}` : '<span class="muted">2: not yet</span>'}</td>
          <td>${flags(r)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">No reseller matches.</td></tr>'}
        </tbody></table></div>`;
      box.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = `#/resellers/${tr.dataset.id}`; });
    }

    // ------------------------------------------------------------ detail drawer
    async function openDetail(id) {
      openId = id;
      if (!dr || !dr.el.isConnected) dr = drawer({ title: 'Reseller', onClose: () => { dr = null; openId = null; if (location.hash.startsWith('#/resellers/')) history.replaceState(null, '', '#/resellers'); } });
      dr.body.innerHTML = '<div class="empty">Loading…</div>';
      let d;
      try { d = await get(`/api/resellers/${id}`); } catch (e) { dr.body.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; return; }
      const r = d.reseller;
      dr.setTitle(`${r.code} · ${r.name || phoneFmt(r.phone)}`);
      const nextCall = r.call1_outcome ? 2 : 1;
      dr.body.innerHTML = `
        <div class="row wrap"><span class="pill ${STAGE_PILL[r.stage] || ''}">${esc(lists.stages[r.stage] || r.stage)}</span>${flags({ ...r, open_alerts: 0 })}
          ${r.group_jid ? `<span class="spacer"></span><a class="btn sm" href="#/chats/${encodeURIComponent(r.instance || '')}/${encodeURIComponent(r.group_jid)}">${icon('chat', 'sm')} Open the group chat</a>` : ''}</div>
        ${r.pause_reason && r.paused ? `<div class="note warn small" style="margin-top:10px">Paused: ${esc(r.pause_reason)}${r.last_reply_text ? `<div style="margin-top:4px">“${esc(r.last_reply_text)}”</div>` : ''}</div>` : ''}

        <h2 class="sec">Log a call</h2>
        <div class="card"><div class="bd stack">
          <div class="row wrap"><div class="seg" data-call><button data-v="1" class="${nextCall === 1 ? 'on' : ''}">Call 1</button><button data-v="2" class="${nextCall === 2 ? 'on' : ''}">Call 2</button></div>
            <input class="in sm" data-note placeholder="Short note (optional)" style="flex:1;min-width:160px"></div>
          <div class="row wrap">${lists.callOutcomes.map(o => `<button class="btn sm ${/Not interested|Wrong|Not on/.test(o) ? 'danger' : ''}" data-outcome="${esc(o)}">${esc(o)}</button>`).join('')}</div>
          <div class="help">Logging call 2 puts the reseller into the loop. Until then the automation never touches the group.</div>
          <div class="small">${r.call1_outcome ? `Call 1: <b>${esc(r.call1_outcome)}</b> ${esc(dateTime(r.call1_at))}${r.call1_note ? ` — ${esc(r.call1_note)}` : ''}` : 'Call 1: not logged'}<br>
            ${r.call2_outcome ? `Call 2: <b>${esc(r.call2_outcome)}</b> ${esc(dateTime(r.call2_at))}${r.call2_note ? ` — ${esc(r.call2_note)}` : ''}` : 'Call 2: not logged'}</div>
        </div></div>

        <h2 class="sec">Which ring</h2>
        <div class="card"><div class="bd stack">
          <div>${r.track ? `<b>${r.track === 'offer' ? 'Offer ring' : 'Follow-up ring'}</b> — ${r.track_source === 'manual' ? 'set by a person (the chat is not read for this)' : 'read from the chat'}` : '<b>No status yet</b>'}
            ${r.track_reason ? `<div class="small muted">${esc(r.track_reason)}</div>` : ''}</div>
          <div class="row wrap"><button class="btn sm" data-track="follow_up">Follow-up</button><button class="btn sm" data-track="offer">Offer</button>
            ${r.track_source === 'manual' ? '<button class="btn sm ghost" data-track="">Let the chat decide again</button>' : ''}</div>
          <div class="small muted">Follow-up batch ${r.fu_batch ?? '—'} · offer batch ${r.of_batch ?? '—'}</div>
        </div></div>

        <h2 class="sec">Close or reopen</h2>
        <div class="row wrap">${ACTIONS.filter(([a]) => showAction(a, r)).map(([a, l, k]) => `<button class="btn sm ${k}" data-action="${a}">${esc(l)}</button>`).join('')}</div>

        <h2 class="sec">Details</h2>
        <div class="card"><div class="bd">
          <div class="form-grid">
            <label class="f"><span>Name</span><input class="in" data-f="name" value="${esc(r.name)}"></label>
            <label class="f"><span>Phone</span><input class="in" data-f="phone" value="${esc(r.phone || '')}"></label>
            <label class="f"><span>Company</span><input class="in" data-f="company" value="${esc(r.company)}"></label>
            <label class="f"><span>City</span><input class="in" data-f="city" value="${esc(r.city)}"></label>
            <label class="f"><span>Email</span><input class="in" data-f="email" value="${esc(r.email)}"></label>
            <label class="f"><span>Owner</span><select class="in" data-f="owner_id"><option value="">No owner</option>${owners.map(o => `<option value="${o.id}" ${o.id === r.owner_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
          </div>
          <label class="f" style="margin-top:10px"><span>Notes</span><textarea class="in" data-f="notes">${esc(r.notes)}</textarea></label>
          <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary sm" data-save>Save details</button></div>
        </div></div>

        <h2 class="sec">Group</h2>
        <div class="card"><div class="bd stack">
          ${r.group_jid ? `<div class="kv"><div>Group</div><div>${esc(r.group_jid)}</div><div>Sender</div><div>${numberChip(numberOf(r.instance)) || esc(r.instance || '—')}</div>
              <div>Bound</div><div>${esc(dateTime(r.bound_at))} by ${esc(r.bound_by || '')}</div><div>First offer</div><div>${esc(dateTime(r.first_offer_at))}</div>
              <div>Last message</div><div>${r.last_msg_at ? `${r.last_msg_by === 'us' ? 'Us' : 'Reseller'}, ${esc(dateTime(r.last_msg_at))}` : '—'}${r.last_msg_text ? `<div class="small muted">${esc(r.last_msg_text.slice(0, 160))}</div>` : ''}</div>
              <div>Readable</div><div>${r.readable === false ? '<span class="pill bad">nothing can be read</span>' : r.readable ? 'yes' : '—'}</div></div>
            <div><button class="btn sm danger" data-unbind>Unbind this group</button></div>`
          : `<div class="small muted">Not bound yet. The desk binds a group by itself when exactly one member's phone matches this reseller and exactly one sender number is in it. You can also bind it here.</div>
            <div class="row wrap"><select class="in sm" data-bnum style="width:auto">${numbers.filter(n => n.role === 'sender').map(n => `<option value="${esc(n.instance)}">${esc(n.label)}</option>`).join('')}</select>
              <select class="in sm" data-bgroup style="flex:1;min-width:180px"><option value="">Pick the group…</option></select><button class="btn sm primary" data-bind>Bind</button></div>`}
        </div></div>

        <h2 class="sec">History</h2>
        <div class="timeline">${timeline(d).join('') || '<div class="muted small">Nothing yet.</div>'}</div>`;
      bindDetail(r);
    }
    function showAction(a, r) {
      if (a === 'hold') return !r.hold;
      if (a === 'unhold') return r.hold;
      if (a === 'resume') return r.paused;
      if (a === 'undo_dnc') return r.dnc;
      if (a === 'dnc') return !r.dnc;
      if (a === 'first_offer_sent') return !r.first_offer_at;
      if (a === 'reopen') return ['exhausted', 'not_interested', 'invalid', 'active_reseller'].includes(r.stage) || r.left_group;
      if (a === 'order_placed') return r.stage !== 'active_reseller';
      if (a === 'not_interested') return r.stage !== 'not_interested';
      if (a === 'invalid') return r.stage !== 'invalid';
      return true;
    }
    function timeline(d) {
      const ev = [
        ...d.sends.map(s => ({ t: s.sent_at, cls: 'sent', html: `<b>Sent ${esc(s.rung_label)}</b> from ${numberChip(numberOf(s.instance)) || esc(s.instance)}${s.tagged ? ` · tagged @${esc(s.tagged)}` : ''}<div class="small muted" style="white-space:pre-wrap">${waFormat(s.text.slice(0, 300))}</div>` })),
        ...d.replies.map(y => ({ t: y.ts, cls: 'reply', html: `<b>Reply</b>${y.sender_name ? ` from ${esc(y.sender_name)}` : ''}${y.stop_word ? ' <span class="pill bad">stop</span>' : ''}${y.signal ? ` <span class="pill info">${esc(y.signal)}</span>` : ''}<div class="small">${esc(y.text)}</div>` })),
        ...d.skips.map(k => ({ t: k.created_at, cls: 'skip', html: `<b>Skipped</b> <span class="small">${esc(k.reason)}</span>` })),
        ...d.events.filter(e => !['send.ok'].includes(e.kind)).map(e => ({ t: e.ts, cls: '', html: `<span class="small">${esc(eventText(e))}</span>` })),
      ].sort((a, b) => new Date(b.t) - new Date(a.t));
      return ev.map(e => `<div class="ev ${e.cls}"><div class="small muted">${esc(dateTime(e.t))}</div>${e.html}</div>`);
    }
    function eventText(e) {
      const d = e.detail || {};
      switch (e.kind) {
        case 'reseller.call': return `Call ${d.call}: ${d.outcome}${d.note ? ` — ${d.note}` : ''} (${e.who || ''})`;
        case 'reseller.track': return `Status set to ${d.track || 'read from chat'} by ${e.who || 'a person'}`;
        case 'reseller.action': return `${d.note} (${e.who || ''})`;
        case 'reseller.bind': return `Group bound ${d.by === 'auto' ? 'automatically' : 'by hand'}${d.note ? ` — ${d.note}` : ''}`;
        case 'reseller.unbind': return 'Group unbound';
        case 'reseller.left': return 'The reseller left the group';
        case 'reseller.reply': return `${d.count} new message(s)${d.stop ? ' with a stop word' : ''}`;
        case 'reseller.edit': return `Details edited (${(d.fields || []).join(', ')})`;
        default: return e.kind;
      }
    }
    function bindDetail(r) {
      const b = dr.body;
      let call = r.call1_outcome ? 2 : 1;
      b.querySelectorAll('[data-call] button').forEach(x => x.onclick = () => { call = Number(x.dataset.v); b.querySelectorAll('[data-call] button').forEach(y => y.classList.toggle('on', y === x)); });
      const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg, 'ok'); await Promise.all([openDetail(r.id), reload()]); } catch (e) { fail(e); } };
      b.querySelectorAll('[data-outcome]').forEach(x => x.onclick = () => act(() => post(`/api/resellers/${r.id}/call`, { call, outcome: x.dataset.outcome, note: b.querySelector('[data-note]').value }), `Call ${call} logged`));
      b.querySelectorAll('[data-track]').forEach(x => x.onclick = () => act(() => post(`/api/resellers/${r.id}/track`, { track: x.dataset.track || null }), 'Status saved'));
      b.querySelectorAll('[data-action]').forEach(x => x.onclick = async () => {
        const a = x.dataset.action;
        if (['dnc', 'invalid', 'not_interested', 'order_placed'].includes(a) && !await confirmBox(x.textContent, `Apply "${x.textContent}" to ${r.name || r.code}?`, { ok: 'Apply', danger: a !== 'order_placed' })) return;
        act(() => post(`/api/resellers/${r.id}/action`, { action: a }), 'Saved');
      });
      b.querySelector('[data-save]').onclick = () => {
        const body = {};
        b.querySelectorAll('[data-f]').forEach(i => { body[i.dataset.f] = i.value; });
        act(() => api('PATCH', `/api/resellers/${r.id}`, body), 'Details saved');
      };
      b.querySelector('[data-unbind]')?.addEventListener('click', async () => {
        if (await confirmBox('Unbind the group', 'The row loses its group and its two batches. The desk may bind it again by itself if the group still matches.', { ok: 'Unbind', danger: true })) act(() => post(`/api/resellers/${r.id}/unbind`), 'Unbound');
      });
      const bnum = b.querySelector('[data-bnum]'), bgroup = b.querySelector('[data-bgroup]');
      const fillGroups = async () => {
        if (!bnum) return;
        const gs = await get(`/api/groups?instance=${encodeURIComponent(bnum.value)}`);
        bgroup.innerHTML = '<option value="">Pick the group…</option>' + gs.filter(g => !g.left_group && !g.reseller_id).map(g => `<option value="${esc(g.jid)}">${esc(g.subject || g.jid)} (${g.size || '?'})</option>`).join('');
      };
      if (bnum) { bnum.onchange = fillGroups; fillGroups().catch(fail); }
      b.querySelector('[data-bind]')?.addEventListener('click', () => {
        if (!bgroup.value) return toast('Pick the group first', 'bad');
        act(() => post(`/api/resellers/${r.id}/bind`, { instance: bnum.value, jid: bgroup.value }), 'Group bound');
      });
    }

    // ------------------------------------------------------------ import and add
    function openImport() {
      const c = modal({
        title: 'Import leads', wide: true,
        body: `<div class="stack">
          <div class="note small">Paste rows from the sheet (with the header row) or pick a CSV file. A column named <b>phone</b> (or mobile / whatsapp / number) is required;
            name, company, city, email, owner and notes are used when present. Every number is normalised to one shape; malformed numbers and duplicates are rejected with the reason.</div>
          <input type="file" accept=".csv,.tsv,.txt,text/csv" data-file>
          <textarea class="in mono" data-csv rows="10" placeholder="Name,Phone,Company,City,Owner&#10;Ravi,98111 11101,Ravi PR,Delhi,Roshan"></textarea>
          <div class="form-grid"><label class="f"><span>Source</span><input class="in" data-src value="Ankush sheet"></label>
            <label class="f"><span>Owner for rows without one</span><select class="in" data-own><option value="">None</option>${owners.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label></div>
          <div data-result></div></div>`,
        actions: [{ label: 'Close' }, { label: 'Import', kind: 'primary', onClick: async ctl => {
          const csv = ctl.body.querySelector('[data-csv]').value;
          if (!csv.trim()) { toast('Paste rows or pick a file first', 'bad'); return false; }
          const r = await post('/api/resellers/import', { csv, source: ctl.body.querySelector('[data-src]').value, owner_id: ctl.body.querySelector('[data-own]').value || null });
          ctl.body.querySelector('[data-result]').innerHTML = `<div class="note ok">${r.added.length} added.</div>
            ${r.rejected.length ? `<div class="note bad" style="margin-top:8px"><b>${r.rejected.length} rejected:</b><div class="small">${r.rejected.map(x => `${esc(x.name || '')} ${esc(x.phone || '')} — ${esc(x.reason)}`).join('<br>')}</div></div>` : ''}`;
          ctl.body.querySelector('[data-csv]').value = '';
          await reload();
          return false;
        } }],
      });
      c.body.querySelector('[data-file]').onchange = async e => {
        const f = e.target.files?.[0];
        if (f) c.body.querySelector('[data-csv]').value = await f.text();
      };
    }
    function openAdd() {
      modal({
        title: 'Add a reseller',
        body: `<div class="form-grid">
          <label class="f"><span>Name</span><input class="in" data-f="name"></label>
          <label class="f"><span>Phone (WhatsApp)</span><input class="in" data-f="phone" inputmode="tel"></label>
          <label class="f"><span>Company</span><input class="in" data-f="company"></label>
          <label class="f"><span>City</span><input class="in" data-f="city"></label>
          <label class="f"><span>Owner</span><select class="in" data-f="owner_id"><option value="">None</option>${owners.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label></div>`,
        actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: async ctl => {
          const body = {};
          ctl.body.querySelectorAll('[data-f]').forEach(i => { body[i.dataset.f] = i.value; });
          const r = await post('/api/resellers', body);
          toast(`${r.code} added`, 'ok');
          await reload();
        } }],
      });
    }

    async function reload() {
      rows = await get('/api/resellers');
      render();
    }
    async function load() {
      [lists, owners, numbers] = await Promise.all([get('/api/lists'), get('/api/owners'), numbersList()]);
      await reload();
      if (args[0]) openDetail(Number(args[0]));
    }
    return {
      load, refresh: reload, refreshMs: 30000, refreshWhileTyping: false,
      onArgs(a) { if (a[0] && Number(a[0]) !== openId) openDetail(Number(a[0])); else if (!a[0] && dr) dr.close(); },
      destroy() { dr?.close(); },
    };
  },
};
