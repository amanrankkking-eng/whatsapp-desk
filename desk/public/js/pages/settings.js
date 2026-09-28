// Every rule the flow runs on, editable in one place, plus owners and the chat space.
import { get, post, api, esc, icon, toast, fail, modal, confirmBox } from '../core.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default {
  id: 'settings', title: 'Settings', icon: 'settings',
  create({ view }) {
    let s = null, owners = [];
    const num = (k, label, help, min, max) => `<label class="f"><span>${label}</span><input class="in" type="number" data-n="${k}" value="${esc(s[k])}" min="${min}" max="${max}">${help ? `<span class="help">${help}</span>` : ''}</label>`;
    const phoneRows = (key, map) => `<div class="stack" data-map="${key}">${Object.entries(map || {}).map(([p, n]) => phoneRow(p, n)).join('')}</div>
      <button class="btn sm" data-addrow="${key}" type="button" style="margin-top:8px">${icon('plus', 'sm')} Add</button>`;
    const phoneRow = (p = '', n = '') => `<div class="row" data-pr><input class="in sm" data-pp value="${esc(p)}" placeholder="919876543210" inputmode="tel" style="max-width:200px">
      <input class="in sm" data-pn value="${esc(n)}" placeholder="Name"><button class="icon-btn" data-rm type="button">${icon('x')}</button></div>`;

    function render() {
      view.innerHTML = `<div class="page">
        <div class="card"><div class="hd"><h3>Google Chat</h3></div><div class="bd stack">
          <label class="f"><span>Team chat space webhook</span><input class="in" data-t="team_chat_webhook" value="${esc(s.team_chat_webhook)}" placeholder="https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…">
            <span class="help">After every run the day's summary goes here: what went, what was skipped and why, who waits, who needs a status, who is due tomorrow, unanswered replies. In Google Chat: space → Apps &amp; integrations → Webhooks → Add.</span></label>
          <div><button class="btn sm" data-test="team_chat_webhook" type="button">Send a test message</button></div></div></div>

        <div class="card"><div class="hd"><h3>Owners</h3><span class="spacer"></span><button class="btn sm primary" data-newowner type="button">${icon('plus', 'sm')} Add owner</button></div>
          <div class="bd">${owners.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Alerts go to</th><th class="num">Resellers</th><th></th></tr></thead><tbody>
            ${owners.map(o => `<tr><td><b>${esc(o.name)}</b>${o.active ? '' : ' <span class="pill">inactive</span>'}</td><td class="small">${o.phone ? `+${esc(o.phone)}` : '—'}</td>
              <td class="small">${o.chat_webhook ? 'their own chat space' : 'the team chat space'}</td><td class="num">${o.resellers}</td>
              <td class="nowrap"><button class="btn sm" data-editowner="${o.id}" type="button">Edit</button></td></tr>`).join('')}</tbody></table></div>`
            : '<div class="muted">No owner yet. Every group needs one named person who gets its alerts.</div>'}</div></div>

        <div class="card"><div class="hd"><h3>Our side</h3></div><div class="bd stack">
          <div><b>Team numbers</b><div class="help">Never tagged, never counted as a reseller, whatever name they are saved under.</div>${phoneRows('team_numbers', s.team_numbers)}</div>
          <div><b>Other company numbers</b><div class="help">Numbers of ours that are not connected here (for example the Periskope numbers). Their messages count as ours.</div>${phoneRows('extra_own_numbers', s.extra_own_numbers)}</div>
          <div class="help">Also treated as ours: every number connected here, and anyone who sits in two or more of our groups.</div></div></div>

        <div class="card"><div class="hd"><h3>Sending</h3></div><div class="bd stack">
          <div class="f"><span class="small" style="font-weight:500;color:var(--text-2)">Send days</span>
            <div class="row wrap">${DAYS.map(d => `<label class="check"><input type="checkbox" data-day="${d}" ${s.send_days.includes(d) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
          <div class="form-grid">
            <label class="f"><span>Window opens</span><input class="in" type="time" data-t="window_start" value="${esc(s.window_start)}"></label>
            <label class="f"><span>Window closes</span><input class="in" type="time" data-t="window_end" value="${esc(s.window_end)}"></label>
            ${num('gap_min_sec', 'Shortest gap (seconds)', '301 = 5 min 1 s', 30, 3600)}
            ${num('gap_max_sec', 'Longest gap (seconds)', '840 = 14 min. A gap on a whole minute is drawn again.', 30, 7200)}
            ${num('daily_cap_total', 'Daily total across all senders', 'Each sender also has its own cap on the Numbers page.', 0, 500)}
            ${num('warmup_days', 'Warm-up for a new number (days)', 'No automatic message from a number younger than this.', 0, 90)}
          </div></div></div>

        <div class="card"><div class="hd"><h3>The six checks</h3></div><div class="bd form-grid">
          ${num('min_gap_days', 'Gap: days since our last message', 'At least this many days.', 0, 60)}
          ${num('client_active_days', 'Live conversation: reseller wrote within (days)', '', 0, 60)}
          ${num('our_active_days', 'Live conversation: we wrote within (days)', '', 0, 60)}
          ${num('ball_in_court_days', 'Unanswered question: reseller had the last word within (days)', '', 0, 120)}
          <div class="help" style="grid-column:1/-1">The other two checks have nothing to set: this exact message never went to the group before, the reseller is still a member, and the group can be read.</div>
        </div></div>

        <div class="card"><div class="hd"><h3>Rings and batches</h3></div><div class="bd form-grid">
          ${num('batch_size', 'Groups per batch', '', 1, 200)}
          ${num('ring_min_batches', 'Smallest ring (batches)', 'A small pool is padded with rest days so a ring never turns faster than this. 16 keeps every group clear of the 10-day gap.', 1, 200)}
        </div></div>

        <div class="card"><div class="hd"><h3>Tags and texts</h3></div><div class="bd stack">
          <div class="form-grid">${num('tag_cooldown_days', 'Do not tag the same person again within (days)', '', 0, 60)}
            <label class="f"><span>Business name</span><input class="in" data-t="business_name" value="${esc(s.business_name)}"></label></div>
          <label class="f"><span>First line when someone is tagged</span><input class="in" data-t="greeting_template" value="${esc(s.greeting_template)}"><span class="help">{tag} becomes the @mention.</span></label>
          <label class="f"><span>Opening line after a slice moves to a new sender</span><input class="in" data-t="intro_template" value="${esc(s.intro_template)}"><span class="help">{sender_name} becomes the new number's WhatsApp name.</span></label>
        </div></div>

        <div class="card"><div class="hd"><h3>Alerts</h3></div><div class="bd form-grid">
          ${num('alert_repeat_min', 'Repeat an unacknowledged alert every (minutes)', '', 5, 1440)}
          <label class="f"><span>Alerts from</span><input class="in" type="time" data-ah="0" value="${esc(s.alert_hours[0])}"></label>
          <label class="f"><span>Alerts until</span><input class="in" type="time" data-ah="1" value="${esc(s.alert_hours[1])}"></label>
        </div></div>

        <div class="card"><div class="hd"><h3>Groups kept out</h3></div><div class="bd form-grid">
          <label class="f"><span>Never-send list (exact group names, one per line)</span><textarea class="in" data-list="never_send_names" rows="6">${esc(s.never_send_names.join('\n'))}</textarea>
            <span class="help">Test rooms and our own internal rooms. Never bound, never messaged.</span></label>
          <label class="f"><span>Keep out any group whose name contains (one per line)</span><textarea class="in" data-list="exclude_name_words" rows="6">${esc(s.exclude_name_words.join('\n'))}</textarea>
            <span class="help">"01wire" keeps Ahmad sir's 01Wire groups out of this reseller loop. Spaces and dashes are ignored when matching.</span></label>
        </div></div>

        <div class="sticky-actions"><span class="small muted">Changes apply from the next preview.</span><span class="spacer"></span><button class="btn primary" data-save type="button">Save settings</button></div>
      </div>`;
      bind();
    }
    function readMap(key) {
      const out = {};
      view.querySelectorAll(`[data-map="${key}"] [data-pr]`).forEach(r => {
        const p = r.querySelector('[data-pp]').value.replace(/\D/g, '');
        if (p) out[p] = r.querySelector('[data-pn]').value.trim();
      });
      return out;
    }
    function bind() {
      view.addEventListener('click', e => { if (e.target.closest('[data-rm]')) e.target.closest('[data-pr]').remove(); });
      view.querySelectorAll('[data-addrow]').forEach(b => b.onclick = () => view.querySelector(`[data-map="${b.dataset.addrow}"]`).insertAdjacentHTML('beforeend', phoneRow()));
      view.querySelector('[data-test]').onclick = async () => {
        try { await post('/api/settings/test-chat', { webhook: view.querySelector('[data-t="team_chat_webhook"]').value }); toast('Test message sent', 'ok'); } catch (e) { fail(e); }
      };
      view.querySelector('[data-newowner]').onclick = () => editOwner({});
      view.querySelectorAll('[data-editowner]').forEach(b => b.onclick = () => editOwner(owners.find(o => o.id === Number(b.dataset.editowner))));
      view.querySelector('[data-save]').onclick = async () => {
        const body = {};
        view.querySelectorAll('[data-n]').forEach(i => { body[i.dataset.n] = Number(i.value); });
        view.querySelectorAll('[data-t]').forEach(i => { body[i.dataset.t] = i.value; });
        view.querySelectorAll('[data-list]').forEach(i => { body[i.dataset.list] = i.value.split('\n').map(x => x.trim()).filter(Boolean); });
        body.send_days = [...view.querySelectorAll('[data-day]:checked')].map(i => i.dataset.day);
        body.alert_hours = [view.querySelector('[data-ah="0"]').value, view.querySelector('[data-ah="1"]').value];
        body.team_numbers = readMap('team_numbers');
        body.extra_own_numbers = readMap('extra_own_numbers');
        try { s = await api('PUT', '/api/settings', body); toast('Settings saved', 'ok'); render(); } catch (e) { fail(e); }
      };
    }
    function editOwner(o) {
      modal({
        title: o.id ? `Edit ${o.name}` : 'Add an owner',
        body: `<div class="stack"><label class="f"><span>Name</span><input class="in" data-f="name" value="${esc(o.name || '')}"></label>
          <label class="f"><span>Phone</span><input class="in" data-f="phone" value="${esc(o.phone || '')}" inputmode="tel"></label>
          <label class="f"><span>Their own Google Chat webhook (optional)</span><input class="in" data-f="chat_webhook" value="${esc(o.chat_webhook || '')}" placeholder="https://chat.googleapis.com/v1/spaces/…">
            <span class="help">Their alerts and their daily brief go here. Without one, alerts name them in the team space.</span></label>
          ${o.id ? `<label class="check"><input type="checkbox" data-f="active" ${o.active ? 'checked' : ''}> Active</label>` : ''}</div>`,
        actions: [
          ...(o.id ? [{ label: 'Delete', kind: 'danger', onClick: async () => {
            if (!await confirmBox('Delete owner', `Delete ${o.name}?`, { ok: 'Delete', danger: true })) return false;
            await api('DELETE', `/api/owners/${o.id}`); await load();
          } }] : []),
          ...(o.chat_webhook ? [{ label: 'Test their chat', onClick: async () => { await post('/api/settings/test-chat', { webhook: o.chat_webhook }); toast('Test message sent', 'ok'); return false; } }] : []),
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: async ctl => {
            const v = k => ctl.body.querySelector(`[data-f="${k}"]`);
            await post('/api/owners', { id: o.id, name: v('name').value, phone: v('phone').value, chat_webhook: v('chat_webhook').value, active: v('active') ? v('active').checked : true });
            toast('Owner saved', 'ok'); await load();
          } },
        ],
      });
    }
    async function load() {
      [s, owners] = await Promise.all([get('/api/settings'), get('/api/owners')]);
      render();
    }
    return { load };
  },
};
