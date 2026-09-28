// WhatsApp numbers: add one (QR or pairing code), roles, caps, warm-up, reconnect, move a slice.
import { get, post, api, esc, icon, toast, fail, modal, confirmBox, numbersList, numberColor, stateLabel, niceDate, bus } from '../core.js';

// ---------------------------------------------------------------- linking dialog
// Opens for a new number (create first) or an existing one (reconnect). Polls until connected.
export function openAddWhatsApp(onDone, existing) {
  let instance = existing?.instance || null, timer = null, mode = 'qr', finished = false;
  const ctl = modal({
    title: existing ? `Connect ${existing.label}` : 'Add a WhatsApp number',
    body: existing ? '<div data-link></div>' : `
      <div class="stack" data-form>
        <label class="f"><span>Name for this number</span><input class="in" data-label maxlength="60" placeholder="For example: Sender 2, Reader, Priya's phone"></label>
        <div class="f"><span class="small" style="font-weight:500;color:var(--text-2)">Role</span>
          <div class="seg" data-role><button data-v="sender" class="on" type="button">Sender</button><button data-v="reader" type="button">Reader</button></div>
          <div class="help">Senders carry their own slice of groups. The reader sits in every group and never sends anything.</div></div>
        <label class="check"><input type="checkbox" data-hist checked> Bring in the chats this phone already has</label>
        <details><summary class="small muted" style="cursor:pointer">Can't scan a QR? Link with the phone number instead</summary>
          <label class="f" style="margin-top:8px"><span>Phone number of the WhatsApp being added</span><input class="in" data-phone inputmode="tel" placeholder="98xxxxxxxx or +91 98xxxxxxxx"></label>
          <div class="help">You will get an 8-character code to type into WhatsApp on that phone.</div></details>
        <div class="note warn small">Use a new number for this dashboard. Do not link the Periskope numbers or the Cloud Station number here.</div>
      </div><div data-link class="hidden"></div>`,
    wide: false,
    onClose() { clearInterval(timer); if (instance) { bus.emit('numbers-changed'); onDone?.(instance); } },
    actions: existing ? [{ label: 'Close' }] : [{ label: 'Cancel' }, { label: 'Create and show QR', kind: 'primary', onClick: create }],
  });
  const $ = s => ctl.body.querySelector(s);
  let role = 'sender';
  ctl.body.querySelectorAll('[data-role] button').forEach(b => b.onclick = () => {
    role = b.dataset.v;
    ctl.body.querySelectorAll('[data-role] button').forEach(x => x.classList.toggle('on', x === b));
  });

  async function create() {
    const label = $('[data-label]').value.trim();
    if (!label) { toast('Give the number a name first.', 'bad'); $('[data-label]').focus(); return false; }
    const phone = $('[data-phone]').value.trim();
    mode = phone ? 'code' : 'qr';
    const r = await post('/api/numbers', { label, role, phone: phone || undefined, history: $('[data-hist]').checked });
    instance = r.instance;
    await numbersList(true);
    $('[data-form]').classList.add('hidden');
    $('[data-link]').classList.remove('hidden');
    ctl.setActions([{ label: 'Close' }]);
    show(r);
    start();
    return false;
  }
  function show(r) {
    const box = $('[data-link]');
    if (r.state === 'open') {
      finished = true;
      clearInterval(timer);
      box.innerHTML = `<div class="qr-box"><div class="brand-logo" style="width:64px;height:64px">${icon('check')}</div>
        <div style="font-size:18px;font-weight:600">Connected</div><div class="muted">The number is linked. Its chats and groups load in a minute or two.</div></div>`;
      ctl.setActions([{ label: 'Done', kind: 'primary' }]);
      toast('WhatsApp connected', 'ok');
      return;
    }
    // A closed connection is restarted only when the person asks (see linkInfo on the server).
    if (r.state === 'close' && !r.qr && !r.pairingCode) {
      const msg = r.reconnecting ? 'The number was connected a moment ago and is reconnecting by itself. Wait a few seconds.'
        : r.starting ? 'Starting a new connection. The QR appears in a few seconds.'
        : 'No QR is showing: the last one expired or the connection closed.';
      box.innerHTML = `<div class="qr-box"><div class="muted" style="max-width:320px">${esc(msg)}</div>
        ${r.reconnecting || r.starting ? '' : '<button class="btn primary" data-newqr>Get a new QR</button>'}</div>`;
      box.querySelector('[data-newqr]')?.addEventListener('click', async e => {
        e.target.disabled = true;
        try { show(await get(`/api/numbers/${encodeURIComponent(instance)}/link?start=1`)); } catch (err) { fail(err); e.target.disabled = false; }
      });
      return;
    }
    const code = r.pairingCode;
    box.innerHTML = `<div class="qr-box">
      ${code ? `<div class="pair-code">${esc(code.slice(0, 4))}-${esc(code.slice(4))}</div>
        <ol class="steps"><li>Open WhatsApp on the phone being added.</li><li>Settings → Linked devices → Link a device.</li>
          <li>Tap <b>Link with phone number instead</b>.</li><li>Type the code above.</li></ol>`
      : r.qr ? `<img alt="QR code to scan" src="${esc(r.qr)}">
        <ol class="steps"><li>Open WhatsApp on the phone being added.</li><li>Settings → Linked devices → Link a device.</li>
          <li>Point the phone at this code. It refreshes by itself.</li></ol>`
      : '<div class="muted">Preparing the code…</div>'}
      <div class="small muted">Waiting for the phone… this window updates on its own.</div>
      ${code ? '' : '<button class="btn sm ghost" data-usecode>Link with a phone number instead</button>'}</div>`;
    box.querySelector('[data-usecode]')?.addEventListener('click', async () => {
      const phone = prompt('Phone number of the WhatsApp being added (with country code):');
      if (!phone) return;
      try { mode = 'code'; show(await get(`/api/numbers/${encodeURIComponent(instance)}/link?start=1&phone=${encodeURIComponent(phone)}`)); }
      catch (e) { fail(e); }
    });
  }
  function start() {
    clearInterval(timer);
    let lastCode = null;
    timer = setInterval(async () => {
      if (finished) return;
      try {
        const r = await get(`/api/numbers/${encodeURIComponent(instance)}/link`);
        if (mode === 'code' && r.state !== 'open') { if (!r.pairingCode && lastCode) r.pairingCode = lastCode; lastCode = r.pairingCode || lastCode; }
        show(r);
      } catch (e) {
        // Keep trying: a restart of the desk or Evolution must not leave a dead QR on screen.
        const box = $('[data-link]');
        box.querySelector('[data-err]')?.remove();
        box.insertAdjacentHTML('beforeend', `<div class="note warn small" data-err>${esc(e.message)} — retrying…</div>`);
      }
    }, 3000);
  }
  if (existing) {
    get(`/api/numbers/${encodeURIComponent(instance)}/link?start=1`).then(r => { show(r); start(); }).catch(e => { $('[data-link]').innerHTML = `<div class="note bad">${esc(e.message)}</div>`; });
  }
  return ctl;
}

// ---------------------------------------------------------------- page
export default {
  id: 'numbers', title: 'Numbers', icon: 'phone',
  create({ view, actions }) {
    let list = [], settings = null;
    actions.innerHTML = `<button class="btn primary" data-add>${icon('plus')} Add WhatsApp</button>`;
    actions.querySelector('[data-add]').onclick = () => openAddWhatsApp(() => load());
    const off = bus.on('numbers-changed', () => load());

    function warm(n) {
      if (!n.warmup_started) return '<span class="pill ok">Warmed up</span>';
      const day = Math.floor((Date.now() - new Date(`${n.warmup_started}T00:00:00+05:30`).getTime()) / 86400000) + 1;
      const total = settings?.warmup_days ?? 21;
      return day > total ? '<span class="pill ok">Warmed up</span>' : `<span class="pill warn">Warming up: day ${day} of ${total}</span>`;
    }
    function render() {
      const senders = list.filter(n => n.role === 'sender');
      view.innerHTML = `<div class="page">
        <div class="note small">One Evolution server holds every number. Each number keeps its own chats. Senders each carry a slice of the reseller groups
          (the sender that sits in a group owns it); the reader sits in every group and only reads.</div>
        <div class="grid k2" style="margin-top:14px">${list.map(n => `
          <div class="card" data-inst="${esc(n.instance)}">
            <div class="hd"><span class="chip-n" style="background:${numberColor(n)}">${esc(n.role === 'reader' ? 'Reader' : 'Sender')}</span>
              <h3 style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(n.label)}</h3>
              <span class="row small"><span class="dot ${esc(n.state)}"></span>${esc(stateLabel(n.state))}</span></div>
            <div class="bd stack">
              <div class="kv"><div>Phone</div><div>${n.phone ? `+${esc(n.phone)}` : '<span class="muted">not linked yet</span>'}${n.profile_name ? ` · ${esc(n.profile_name)}` : ''}</div>
                <div>Groups</div><div>${n.groups}${n.role === 'sender' ? ` · owns <b>${n.slice}</b> reseller group${n.slice === 1 ? '' : 's'}` : ''}</div>
                <div>Warm-up</div><div>${warm(n)}${n.warmup_started ? ` <span class="small muted">since ${esc(niceDate(n.warmup_started))}</span>` : ''}</div>
                ${n.role === 'sender' ? `<div>Daily cap</div><div><input class="in sm" type="number" min="0" max="200" value="${n.daily_cap}" data-cap style="width:90px"> automatic messages a day</div>` : ''}
                <div>Status</div><div><label class="check"><input type="checkbox" data-active ${n.active ? 'checked' : ''}> In use</label></div>
                <div>Evolution id</div><div class="mono">${esc(n.instance)}</div></div>
              <div class="row wrap">
                ${n.state !== 'open' ? `<button class="btn sm primary" data-connect>${icon('qr', 'sm')} Connect / show QR</button>` : ''}
                <button class="btn sm" data-rename>${icon('edit', 'sm')} Rename</button>
                <button class="btn sm" data-role>${n.role === 'sender' ? 'Make reader' : 'Make sender'}</button>
                ${n.warmup_started ? '<button class="btn sm" data-warm>End warm-up</button>' : ''}
                ${n.state === 'open' ? `<button class="btn sm" data-groups>${icon('refresh', 'sm')} Refresh groups</button>` : ''}
                ${n.role === 'sender' && n.slice ? `<button class="btn sm" data-move>Move slice…</button>` : ''}
                <a class="btn sm ghost" href="#/chats/${encodeURIComponent(n.instance)}">${icon('chat', 'sm')} Chats</a>
                <span class="spacer"></span>
                ${n.state === 'open' ? '<button class="btn sm danger" data-logout>Log out</button>' : ''}
                <button class="btn sm danger" data-remove title="Remove from Evolution">${icon('trash', 'sm')}</button>
              </div>
            </div></div>`).join('')}
          <button class="card" data-add2 style="min-height:180px;border-style:dashed;cursor:pointer;display:grid;place-items:center;color:var(--text-2);background:transparent">
            <div class="stack" style="justify-items:center">${icon('plus')}<b>Add WhatsApp</b><span class="small muted">Scan a QR or use a pairing code</span></div></button>
        </div>
        ${senders.length ? '' : '<div class="note warn" style="margin-top:14px">No sender number yet. Add at least one sender for the reseller loop.</div>'}
        <h2 class="sec">How the numbers share the work</h2>
        <div class="card"><div class="bd small stack">
          <div>• A reseller group belongs to the one sender number that is in it. That sender sends every automatic message to that group, so the reseller always hears from the same number.</div>
          <div>• Each sender sends one message at a time with a random 5–14 minute gap, 10:30–17:30 Monday to Friday, up to its own daily cap.</div>
          <div>• New numbers warm up for ${settings?.warmup_days ?? 21} days before they carry automatic messages. Ramp a number's cap slowly (25, then 50, then its full share across all its traffic).</div>
          <div>• If a sender is lost, only its slice stops. Use <b>Move slice</b> to give its groups to another sender; add that sender to those groups first. Its next message opens by saying who is writing now.</div>
        </div></div></div>`;
      view.querySelector('[data-add2]').onclick = () => openAddWhatsApp(() => load());
      view.querySelectorAll('[data-inst]').forEach(card => {
        const n = list.find(x => x.instance === card.dataset.inst);
        const patch = async (body, msg) => { try { await api('PATCH', `/api/numbers/${encodeURIComponent(n.instance)}`, body); if (msg) toast(msg, 'ok'); await load(true); } catch (e) { fail(e); await load(true); } };
        card.querySelector('[data-connect]')?.addEventListener('click', () => openAddWhatsApp(() => load(true), n));
        card.querySelector('[data-rename]').onclick = () => {
          const c = modal({ title: 'Rename number', body: `<label class="f"><span>Name</span><input class="in" data-v maxlength="60" value="${esc(n.label)}"></label>`,
            actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => patch({ label: c.body.querySelector('[data-v]').value }, 'Saved') }] });
        };
        card.querySelector('[data-role]').onclick = async () => {
          const to = n.role === 'sender' ? 'reader' : 'sender';
          if (await confirmBox('Change role', to === 'reader' ? `${n.label} becomes the reader. It will never send anything, not even a reply from the inbox.` : `${n.label} becomes a sender. It will send to the reseller groups it sits in.`, { ok: `Make ${to}` })) patch({ role: to }, 'Role changed');
        };
        card.querySelector('[data-warm]')?.addEventListener('click', async () => {
          if (await confirmBox('End warm-up', `${n.label} will start carrying automatic messages from the next approved day. Only do this if the number has been in normal use for about three weeks.`, { ok: 'End warm-up' })) patch({ warmed: true }, 'Warm-up ended');
        });
        card.querySelector('[data-cap]')?.addEventListener('change', e => patch({ daily_cap: Number(e.target.value) }, 'Cap saved'));
        card.querySelector('[data-active]').onchange = e => patch({ active: e.target.checked }, e.target.checked ? 'In use' : 'Paused');
        card.querySelector('[data-groups]')?.addEventListener('click', async e => {
          e.target.disabled = true;
          try { const r = await post(`/api/numbers/${encodeURIComponent(n.instance)}/refresh-groups`); toast(`${r.groups} groups read`, 'ok'); await load(true); } catch (err) { fail(err); } finally { e.target.disabled = false; }
        });
        card.querySelector('[data-move]')?.addEventListener('click', () => {
          const others = list.filter(x => x.role === 'sender' && x.instance !== n.instance);
          if (!others.length) return toast('Add another sender number first.', 'bad');
          const c = modal({ title: `Move ${n.label}'s slice`, body: `<p style="margin-top:0">All ${n.slice} reseller groups of ${esc(n.label)} move to the number you pick. Put that number into those groups first; until it is in a group, that group is skipped with the reason shown.</p>
            <label class="f"><span>Move to</span><select class="in" data-to>${others.map(o => `<option value="${esc(o.instance)}">${esc(o.label)} (${esc(stateLabel(o.state))})</option>`).join('')}</select></label>
            <p class="help">Each group's next message opens with: "${esc(settings?.intro_template || '')}"</p>`,
            actions: [{ label: 'Cancel' }, { label: 'Move slice', kind: 'primary', onClick: async () => {
              const r = await post('/api/numbers/move-slice', { from: n.instance, to: c.body.querySelector('[data-to]').value });
              toast(`${r.moved} groups moved`, 'ok'); await load(true);
            } }] });
        });
        card.querySelector('[data-logout]')?.addEventListener('click', async () => {
          if (!await confirmBox('Log out', `${n.label} will be logged out of WhatsApp. Its slice stops until it is connected again.`, { ok: 'Log out', danger: true })) return;
          try { await post(`/api/numbers/${encodeURIComponent(n.instance)}/logout`); toast('Logged out'); await load(true); } catch (e) { fail(e); }
        });
        card.querySelector('[data-remove]').onclick = async () => {
          if (!await confirmBox('Remove number', `Remove ${n.label} from Evolution? Its WhatsApp session is deleted. The desk keeps every send and reply already recorded.`, { ok: 'Remove', danger: true })) return;
          try { await api('DELETE', `/api/numbers/${encodeURIComponent(n.instance)}`); toast('Removed'); await load(true); } catch (e) { fail(e); }
        };
      });
    }
    async function load(force) {
      [list, settings] = await Promise.all([numbersList(force !== false), settings ? Promise.resolve(settings) : get('/api/settings')]);
      render();
    }
    return { load, refresh: () => load(true), refreshMs: 15000, destroy: off };
  },
};
