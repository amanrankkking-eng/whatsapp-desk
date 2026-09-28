// Stage 6: the two message ladders, the rate card they are built from, and the five heading styles.
import { get, post, api, esc, icon, toast, fail, modal, confirmBox, debounce, waFormat } from '../core.js';

const TOKENS = '{heading} {price} {outlets} {outlet_list} {lead} {reach} {tat} {sample} {business}';

export default {
  id: 'messages', title: 'Messages & rate card', icon: 'ladder',
  create({ view, args }) {
    let tab = args[0] || 'ladders', st = null;

    function rungCard(r, list) {
      const i = list.indexOf(r);
      return `<div class="rung ${r.active ? '' : 'off'}" data-rung="${r.id}">
        <div class="row wrap"><span class="pill">${i + 1}</span><b>${esc(r.label)}</b>
          ${r.package_id ? `<span class="pill info">${esc(st.packages.find(p => p.id === r.package_id)?.label || 'package deleted')}</span>` : ''}
          ${r.active ? '' : '<span class="pill">switched off</span>'}
          ${r.problem ? `<span class="pill bad" title="It is held, never sent, until this is fixed">${esc(r.problem)}</span>` : ''}
          <span class="small muted">sent ${r.sent_count} time${r.sent_count === 1 ? '' : 's'}</span><span class="spacer"></span>
          <button class="icon-btn" data-up title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button class="icon-btn" data-down title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
          <button class="btn sm" data-edit>${icon('edit', 'sm')} Edit</button></div>
        <pre>${esc(r.template)}</pre></div>`;
    }
    function ladders() {
      const fu = st.rungs.filter(r => r.ring === 'follow_up'), of = st.rungs.filter(r => r.ring === 'offer');
      return `<div class="note small">Each group gets the next message in its own ladder that it has never had; a group can never get the same one twice.
          The label is the message's identity in the record, so a label that was already sent cannot be renamed. When a group has had every message in its ladder
          it is marked exhausted; adding a new message brings it back.</div>
        <div class="grid k2" style="margin-top:14px">
          <div><h2 class="sec" style="margin-top:0">Follow-up ladder <span class="badge grey">${fu.length}</span><span class="spacer"></span><button class="btn sm primary" data-new="follow_up">${icon('plus', 'sm')} New</button></h2>
            ${fu.map(r => rungCard(r, fu)).join('') || '<div class="card"><div class="empty">No messages.</div></div>'}</div>
          <div><h2 class="sec" style="margin-top:0">Offer ladder <span class="badge grey">${of.length}</span><span class="spacer"></span><button class="btn sm primary" data-new="offer">${icon('plus', 'sm')} New</button></h2>
            ${of.map(r => rungCard(r, of)).join('') || '<div class="card"><div class="empty">No messages.</div></div>'}</div>
        </div>`;
    }
    function rateCard() {
      return `<div class="note small">Offer messages are built from this card. An outlet switched off here is dropped from every message automatically.
          The package name (Package 1, 2…) never appears in a message; it is only a label on the send record.</div>
        <div class="row" style="margin:14px 0"><span class="spacer"></span><button class="btn sm primary" data-newpkg>${icon('plus', 'sm')} New package</button></div>
        <div class="grid k2">${st.packages.map(p => `<div class="card" data-pkg="${p.id}"><div class="hd"><h3>${esc(p.label)}</h3>
            ${p.active ? '' : '<span class="pill">switched off</span>'}<span class="spacer"></span><b>${esc(p.price)}</b></div>
          <div class="bd stack"><div class="small muted">${esc(p.tat)} · ${esc(p.reach)}${p.sample_url ? ` · <a href="${esc(p.sample_url)}" target="_blank" rel="noopener noreferrer">sample</a>` : ''}</div>
            <div class="row wrap">${p.outlets.map(o => `<span class="pill ${o.available ? 'ok' : ''}" style="${o.available ? '' : 'text-decoration:line-through'}">${esc(o.name)}</span>`).join('')}</div>
            <div class="row"><span class="spacer"></span><button class="btn sm" data-editpkg>${icon('edit', 'sm')} Edit</button></div></div></div>`).join('')}</div>`;
    }
    function headings() {
      return `<div class="note small">Five heading styles, so the same offer reads differently each time it comes round and one day's messages do not read as one template.
          Tokens: <span class="mono">{lead} {reach} {price} {tat} {outlet_list}</span></div>
        <div class="stack" style="margin-top:14px">${st.headings.map((h, i) => `<label class="f"><span>Style ${i + 1}</span><input class="in" data-h value="${esc(h.template)}"></label>`).join('')}
          <label class="f"><span>Add a style (optional)</span><input class="in" data-h value=""></label>
          <div class="row"><span class="spacer"></span><button class="btn primary" data-saveh>Save heading styles</button></div></div>`;
    }
    async function render() {
      st = await get('/api/ladder');
      view.innerHTML = `<div class="page"><div class="tabs">
          <button data-tab="ladders" class="${tab === 'ladders' ? 'on' : ''}">Message ladders</button>
          <button data-tab="rates" class="${tab === 'rates' ? 'on' : ''}">Rate card</button>
          <button data-tab="headings" class="${tab === 'headings' ? 'on' : ''}">Heading styles</button></div>
        ${tab === 'rates' ? rateCard() : tab === 'headings' ? headings() : ladders()}</div>`;
      view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { location.hash = `#/messages/${b.dataset.tab}`; });
      view.querySelectorAll('[data-new]').forEach(b => b.onclick = () => editRung({ ring: b.dataset.new, label: '', template: '', active: true }));
      view.querySelectorAll('[data-rung]').forEach(el => {
        const r = st.rungs.find(x => x.id === Number(el.dataset.rung));
        el.querySelector('[data-edit]').onclick = () => editRung(r);
        el.querySelector('[data-up]').onclick = () => post(`/api/ladder/rung/${r.id}/move`, { dir: -1 }).then(render).catch(fail);
        el.querySelector('[data-down]').onclick = () => post(`/api/ladder/rung/${r.id}/move`, { dir: 1 }).then(render).catch(fail);
      });
      view.querySelector('[data-newpkg]')?.addEventListener('click', () => editPackage({ label: '', price: '', tat: '', reach: '', sample_url: '', active: true, outlets: [] }));
      view.querySelectorAll('[data-pkg]').forEach(el => { el.querySelector('[data-editpkg]').onclick = () => editPackage(st.packages.find(p => p.id === Number(el.dataset.pkg))); });
      view.querySelector('[data-saveh]')?.addEventListener('click', async () => {
        try {
          await post('/api/ladder/headings', { headings: [...view.querySelectorAll('[data-h]')].map(i => i.value) });
          toast('Heading styles saved', 'ok'); await render();
        } catch (e) { fail(e); }
      });
    }

    function editRung(r) {
      const c = modal({
        title: r.id ? `Edit ${r.label}` : `New ${r.ring === 'offer' ? 'offer' : 'follow-up'} message`, wide: true,
        body: `<div class="grid k2" style="align-items:start">
          <div class="stack">
            <div class="form-grid"><label class="f"><span>Label (its identity)</span><input class="in" data-label value="${esc(r.label)}" maxlength="40" placeholder="F6-seasonal" ${r.sent_count ? 'readonly title="Already sent - cannot be renamed"' : ''}></label>
              <label class="f"><span>Ladder</span><select class="in" data-ring><option value="follow_up" ${r.ring === 'follow_up' ? 'selected' : ''}>Follow-up</option><option value="offer" ${r.ring === 'offer' ? 'selected' : ''}>Offer</option></select></label></div>
            <label class="f"><span>Rate-card package (offers)</span><select class="in" data-pkg><option value="">None</option>${st.packages.map(p => `<option value="${p.id}" ${p.id === r.package_id ? 'selected' : ''}>${esc(p.label)} · ${esc(p.price)}</option>`).join('')}</select></label>
            <label class="f"><span>Message</span><textarea class="in" data-tpl rows="12">${esc(r.template)}</textarea></label>
            <div class="help">Tokens filled from the rate card: <span class="mono">${esc(TOKENS)}</span>. Anything in [square brackets] is unfinished copy and is never sent.
              Do not type @mentions; the tag is added at send time.</div>
            <label class="check"><input type="checkbox" data-active ${r.active !== false ? 'checked' : ''}> In use</label>
          </div>
          <div><div class="small muted" style="margin-bottom:6px">How it will read (one sample per heading style)</div><div data-prev class="stack"></div></div></div>`,
        actions: [
          ...(r.id && !r.sent_count ? [{ label: 'Delete', kind: 'danger', onClick: async () => {
            if (!await confirmBox('Delete message', `Delete ${r.label}? It has never been sent.`, { ok: 'Delete', danger: true })) return false;
            await api('DELETE', `/api/ladder/rung/${r.id}`); toast('Deleted'); await render();
          } }] : []),
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: async ctl => {
            const b = ctl.body;
            await post('/api/ladder/rung', { id: r.id, ring: b.querySelector('[data-ring]').value, label: b.querySelector('[data-label]').value,
              template: b.querySelector('[data-tpl]').value, package_id: b.querySelector('[data-pkg]').value || null, active: b.querySelector('[data-active]').checked });
            toast('Saved', 'ok'); await render();
          } },
        ],
      });
      const prev = debounce(async () => {
        const b = c.body;
        try {
          const p = await post('/api/ladder/preview', { template: b.querySelector('[data-tpl]').value, package_id: b.querySelector('[data-pkg]').value || null });
          b.querySelector('[data-prev]').innerHTML = (p.problem ? `<div class="note bad small">Held, never sent: ${esc(p.problem)}</div>` : '') +
            p.samples.map(t => `<div class="wa-preview"><div class="m sent first"><div class="bub"><span class="txt">${waFormat(t)}</span></div></div></div>`).join('');
        } catch (e) { b.querySelector('[data-prev]').innerHTML = `<div class="note bad small">${esc(e.message)}</div>`; }
      }, 250);
      c.body.querySelector('[data-tpl]').addEventListener('input', prev);
      c.body.querySelector('[data-pkg]').addEventListener('change', prev);
      prev();
    }

    function editPackage(p) {
      const outletRow = (o = { name: '', available: true }) => `<div class="row" data-o><input class="in sm" data-on value="${esc(o.name)}" placeholder="Outlet name">
        <label class="check small nowrap"><input type="checkbox" data-oa ${o.available ? 'checked' : ''}> available</label><button class="icon-btn" data-orm type="button">${icon('x')}</button></div>`;
      const c = modal({
        title: p.id ? `Edit ${p.label}` : 'New package', wide: true,
        body: `<div class="form-grid">
            <label class="f"><span>Package label (internal)</span><input class="in" data-f="label" value="${esc(p.label)}"></label>
            <label class="f"><span>Price</span><input class="in" data-f="price" value="${esc(p.price)}" placeholder="$125"></label>
            <label class="f"><span>Turnaround</span><input class="in" data-f="tat" value="${esc(p.tat)}" placeholder="12-24 hrs"></label>
            <label class="f"><span>Reach</span><input class="in" data-f="reach" value="${esc(p.reach)}" placeholder="250+ Global General Media"></label></div>
          <label class="f" style="margin-top:12px"><span>Sample link</span><input class="in" data-f="sample_url" value="${esc(p.sample_url)}" placeholder="https://…"></label>
          <label class="check" style="margin-top:12px"><input type="checkbox" data-f="active" ${p.active !== false ? 'checked' : ''}> Package in use</label>
          <h2 class="sec">Named outlets</h2><div class="stack" data-outlets>${p.outlets.map(outletRow).join('')}</div>
          <button class="btn sm" data-addo type="button" style="margin-top:8px">${icon('plus', 'sm')} Add outlet</button>`,
        actions: [
          ...(p.id ? [{ label: 'Delete', kind: 'danger', onClick: async () => {
            if (!await confirmBox('Delete package', `Delete ${p.label}? Messages that use it are held until they get another package.`, { ok: 'Delete', danger: true })) return false;
            await api('DELETE', `/api/ladder/package/${p.id}`); toast('Deleted'); await render();
          } }] : []),
          { label: 'Cancel' },
          { label: 'Save', kind: 'primary', onClick: async ctl => {
            const b = ctl.body, v = k => b.querySelector(`[data-f="${k}"]`);
            await post('/api/ladder/package', { id: p.id, label: v('label').value, price: v('price').value, tat: v('tat').value, reach: v('reach').value,
              sample_url: v('sample_url').value, active: v('active').checked,
              outlets: [...b.querySelectorAll('[data-o]')].map(o => ({ name: o.querySelector('[data-on]').value, available: o.querySelector('[data-oa]').checked })) });
            toast('Saved', 'ok'); await render();
          } },
        ],
      });
      const box = c.body.querySelector('[data-outlets]');
      box.addEventListener('click', e => { if (e.target.closest('[data-orm]')) e.target.closest('[data-o]').remove(); });
      c.body.querySelector('[data-addo]').onclick = () => { box.insertAdjacentHTML('beforeend', outletRow()); box.lastElementChild.querySelector('input').focus(); };
    }

    return { load: render, onArgs(a) { tab = a[0] || 'ladders'; render().catch(fail); } };
  },
};
