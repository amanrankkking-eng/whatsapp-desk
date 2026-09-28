// The inbox: every chat of every number, WhatsApp-style. The chat list and the thread each scroll
// on their own; polling only appends new messages and updates ticks in place, so the view never
// jumps while someone is reading further up.
import { get, post, esc, icon, avatar, tick, waFormat, listTime, dayKey, dayLabel, time, toast, fail, modal, lightbox,
  fetchBlob, fileToBase64, numbersList, numberChip, stateLabel, debounce } from '../core.js';

const LS_NUM = 'desk-chats-number', LS_FILTER = 'desk-chats-filter';
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const coarse = matchMedia('(pointer: coarse)').matches;
const MAX_FILE = 16 * 1024 * 1024;

export default {
  id: 'chats', title: 'Chats', icon: 'chat', full: true,
  create({ view, args }) {
    let numbers = [], chats = [], inst = store.get(LS_NUM, 'all'), filter = store.get(LS_FILTER, 'all'), search = '';
    let open = null;               // { instance, jid }
    let thread = null;             // last thread payload
    let limit = 120, loadingOlder = false, threadTimer = null, replyTo = null, unseen = 0, destroyed = false, sending = false;
    const rendered = new Map();    // message key -> { status, el }
    // An ad chat's first message and WhatsApp's ad card share one id; the direction keeps them apart.
    const keyOf = m => `${m.id}:${m.fromMe ? 'o' : 'i'}`;

    view.innerHTML = `<div class="chats">
      <div class="cl-pane">
        <div class="cl-top">
          <div class="row"><select class="in sm" data-num aria-label="WhatsApp number"></select>
            <button class="icon-btn" data-reload title="Refresh">${icon('refresh')}</button></div>
          <label class="search">${icon('search', 'sm')}<input data-search placeholder="Search chats" autocomplete="off"></label>
          <div class="filters">${[['all', 'All'], ['unread', 'Unread'], ['groups', 'Groups'], ['resellers', 'Resellers'], ['direct', 'Direct']]
            .map(([k, l]) => `<button data-f="${k}">${l}</button>`).join('')}</div>
          <div data-numnote></div>
        </div>
        <div class="cl" data-list></div>
      </div>
      <div class="th-pane" data-thread>
        <div class="th-empty"><div>${icon('chat')}<div class="big">WhatsApp Desk</div>
          Pick a chat on the left. Every connected number's chats are here.<br>Messages you send show ✓ sent, ✓✓ delivered and blue ✓✓ read.</div></div>
      </div></div>`;
    const $ = s => view.querySelector(s);
    const listEl = $('[data-list]'), threadEl = $('[data-thread]'), wrap = $('.chats');

    // ------------------------------------------------------------ chat list
    const numberOf = i => numbers.find(n => n.instance === i);
    function renderNumbers() {
      const sel = $('[data-num]');
      sel.innerHTML = `<option value="all">All numbers (${numbers.length})</option>` +
        numbers.map(n => `<option value="${esc(n.instance)}">${esc(n.label)}${n.phone ? ` · +${esc(n.phone)}` : ''} ${n.state === 'open' ? '' : `(${esc(stateLabel(n.state))})`}</option>`).join('');
      if (inst !== 'all' && !numberOf(inst)) inst = 'all';
      sel.value = inst;
      const n = numberOf(inst);
      $('[data-numnote]').innerHTML = n && n.state !== 'open'
        ? `<div class="note warn small">${esc(n.label)} is ${esc(stateLabel(n.state).toLowerCase())}. Open <a href="#/numbers">Numbers</a> to reconnect it.</div>` : '';
      view.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
    }
    // "All numbers" shows each conversation once: through the number that owns it (a reseller
    // group's sender), else a sender, else whichever number has it.
    function visibleChats() {
      let list = chats;
      if (inst === 'all') {
        const by = new Map();
        const rank = c => (c.reseller?.instance === c.instance ? 0 : numberOf(c.instance)?.role === 'sender' ? 1 : 2);
        for (const c of chats) {
          const cur = by.get(c.jid);
          if (!cur) by.set(c.jid, { ...c, also: [c.instance] });
          else {
            cur.also.push(c.instance);
            if (rank(c) < rank(cur)) by.set(c.jid, { ...c, also: cur.also, unread: Math.max(cur.unread, c.unread) });
            else cur.unread = Math.max(cur.unread, c.unread);
          }
        }
        list = [...by.values()].sort((a, b) => b.lastTs - a.lastTs);
      }
      const s = search.trim().toLowerCase();
      return list.filter(c => {
        if (filter === 'unread' && !c.unread) return false;
        if (filter === 'groups' && !c.isGroup) return false;
        if (filter === 'direct' && c.isGroup) return false;
        if (filter === 'resellers' && !c.reseller) return false;
        if (s && !`${c.name || ''} ${c.jid} ${c.reseller?.code || ''} ${c.reseller?.name || ''}`.toLowerCase().includes(s)) return false;
        return true;
      });
    }
    function renderList() {
      const list = visibleChats();
      const top = listEl.scrollTop;
      if (!list.length) {
        listEl.innerHTML = `<div class="empty">${chats.length ? 'No chat matches.' : numbers.length ? 'No chats yet. Messages appear here as soon as the number receives them.' : 'No WhatsApp number is connected yet. Use <b>Add WhatsApp</b>.'}</div>`;
        return;
      }
      listEl.innerHTML = list.map(c => {
        const on = open && open.jid === c.jid && (inst !== 'all' ? open.instance === c.instance : true);
        // One chip: the number this chat opens with. The others are in the thread's "view as" list.
        const more = (c.also || []).length - 1;
        const chips = inst === 'all' ? `${numberChip(numberOf(c.instance))}${more > 0 ? `<span class="small muted">+${more}</span>` : ''}` : '';
        return `<div class="ci ${on ? 'on' : ''} ${c.unread ? 'unread' : ''}" data-open="${esc(c.instance)}|${esc(c.jid)}">
          ${avatar(c.name || c.jid, c.jid, c.isGroup)}
          <div class="body">
            <div class="l1"><span class="name">${esc(c.name || c.jid.split('@')[0])}</span><span class="time">${esc(listTime(c.lastTs))}</span></div>
            <div class="l2"><span class="prev">${c.lastFromMe ? tick(c.lastStatus) : ''}<span class="t">${esc(c.lastText)}</span></span>
              ${c.reseller ? `<span class="pill accent" title="${esc(c.reseller.name)}">${esc(c.reseller.code)}</span>` : ''}
              ${chips}${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
          </div></div>`;
      }).join('');
      listEl.scrollTop = top;
    }
    async function loadList() {
      numbers = await numbersList();
      renderNumbers();
      chats = await get(`/api/chats?instance=${encodeURIComponent(inst)}`);
      if (!destroyed) renderList();
    }

    $('[data-num]').onchange = e => { inst = e.target.value; store.set(LS_NUM, inst); chats = []; renderList(); loadList().catch(fail); };
    $('[data-reload]').onclick = () => { numbersList(true).then(() => loadList()).catch(fail); };
    $('[data-search]').oninput = debounce(e => { search = e.target.value; renderList(); }, 120);
    view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; store.set(LS_FILTER, filter); renderNumbers(); renderList(); });
    listEl.addEventListener('click', e => {
      const el = e.target.closest('[data-open]');
      if (!el) return;
      const [i, ...j] = el.dataset.open.split('|');
      location.hash = `#/chats/${encodeURIComponent(i)}/${encodeURIComponent(j.join('|'))}`;
    });

    // ------------------------------------------------------------ thread
    function threadShell() {
      threadEl.innerHTML = `
        <div class="th-head">
          <button class="icon-btn th-back" data-back aria-label="Back">${icon('back')}</button>
          <div data-av></div>
          <div class="who"><div class="n" data-name></div><div class="s" data-sub></div></div>
          <select class="in sm hidden" data-viewas title="See this chat through another of our numbers" style="width:auto;max-width:180px"></select>
        </div>
        <div class="msgs" data-msgs><div class="empty">Loading…</div></div>
        <button class="to-bottom hidden" data-bottom aria-label="Scroll to the latest">${icon('down')}<span class="badge hidden" data-unseen></span></button>
        <div class="composer" data-composer></div>`;
      threadEl.querySelector('[data-back]').onclick = () => { location.hash = '#/chats'; };
      threadEl.querySelector('[data-bottom]').onclick = () => scrollBottom(true);
      const msgsEl = threadEl.querySelector('[data-msgs]');
      msgsEl.addEventListener('scroll', () => {
        if (nearBottom()) { unseen = 0; updateBottomBtn(); }
        else updateBottomBtn();
        if (msgsEl.scrollTop < 60 && thread && thread.messages.length >= limit && !loadingOlder) loadOlder();
      }, { passive: true });
      msgsEl.addEventListener('click', onMsgClick);
      // Drag and drop a file onto the conversation to send it.
      let dragDepth = 0;
      threadEl.addEventListener('dragenter', e => { if (!canSend() || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); dragDepth++; showDrop(true); });
      threadEl.addEventListener('dragover', e => { if (canSend() && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
      threadEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; showDrop(false); } });
      threadEl.addEventListener('drop', e => {
        if (!canSend()) return;
        e.preventDefault(); dragDepth = 0; showDrop(false);
        const f = e.dataTransfer.files?.[0];
        if (f) previewFile(f);
      });
    }
    function showDrop(on) {
      let d = threadEl.querySelector('.drop-hint');
      if (on && !d) { d = document.createElement('div'); d.className = 'drop-hint'; d.textContent = 'Drop the file to send it'; threadEl.append(d); }
      if (!on) d?.remove();
    }
    const msgsEl = () => threadEl.querySelector('[data-msgs]');
    const nearBottom = () => { const m = msgsEl(); return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 120; };
    function scrollBottom(smooth) {
      const m = msgsEl();
      if (!m) return;
      m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      unseen = 0; updateBottomBtn();
    }
    function updateBottomBtn() {
      const b = threadEl.querySelector('[data-bottom]');
      if (!b) return;
      b.classList.toggle('hidden', nearBottom());
      const u = threadEl.querySelector('[data-unseen]');
      u.textContent = unseen; u.classList.toggle('hidden', !unseen);
    }
    function canSend() {
      if (!thread) return false;
      const n = numberOf(thread.instance);
      return n && n.role !== 'reader' && thread.state === 'open';
    }

    function renderHead() {
      const n = numberOf(thread.instance);
      threadEl.querySelector('[data-av]').innerHTML = avatar(thread.name, thread.jid, thread.isGroup, 'sm');
      threadEl.querySelector('[data-name]').textContent = thread.name;
      const bits = [];
      if (thread.isGroup) bits.push(`Group${thread.size ? ` · ${thread.size} members` : ''}`);
      else bits.push(`+${thread.jid.split('@')[0]}`);
      if (n) bits.push(`via ${n.label}${thread.state !== 'open' ? ` (${stateLabel(thread.state)})` : ''}`);
      const sub = threadEl.querySelector('[data-sub]');
      sub.innerHTML = esc(bits.join(' · ')) + (thread.reseller ? ` · <a href="#/resellers/${thread.reseller.id}">${esc(thread.reseller.code)} ${esc(thread.reseller.name)}</a>${thread.reseller.paused ? ' <span class="pill warn">paused</span>' : ''}${thread.reseller.dnc ? ' <span class="pill bad">do not contact</span>' : ''}` : '');
      // The same group seen by our other numbers.
      const also = chats.filter(c => c.jid === thread.jid).map(c => c.instance);
      const sel = threadEl.querySelector('[data-viewas]');
      const opts = [...new Set([thread.instance, ...also])];
      sel.classList.toggle('hidden', opts.length < 2);
      sel.innerHTML = opts.map(i => `<option value="${esc(i)}">${esc(numberOf(i)?.label || i)}</option>`).join('');
      sel.value = thread.instance;
      sel.onchange = () => { location.hash = `#/chats/${encodeURIComponent(sel.value)}/${encodeURIComponent(thread.jid)}`; };
    }

    function renderComposer() {
      const c = threadEl.querySelector('[data-composer]');
      const n = numberOf(thread.instance);
      if (!n || n.role === 'reader') {
        const senders = chats.filter(x => x.jid === thread.jid && numberOf(x.instance)?.role === 'sender');
        c.innerHTML = `<div class="readonly-bar">${icon('phone', 'sm')} ${esc(n?.label || 'This number')} is the reader. It only reads and never sends.
          ${senders.map(s => `<button class="btn sm primary" data-as="${esc(s.instance)}">Reply as ${esc(numberOf(s.instance)?.label)}</button>`).join('')}</div>`;
        c.querySelectorAll('[data-as]').forEach(b => b.onclick = () => { location.hash = `#/chats/${encodeURIComponent(b.dataset.as)}/${encodeURIComponent(thread.jid)}`; });
        return;
      }
      if (thread.state !== 'open') {
        c.innerHTML = `<div class="readonly-bar">${esc(n.label)} is ${esc(stateLabel(thread.state).toLowerCase())}. <a href="#/numbers">Reconnect it</a> to send.</div>`;
        return;
      }
      c.innerHTML = `<div class="replying hidden" data-replying><div class="q" data-q></div><button class="icon-btn" data-noreply aria-label="Cancel reply">${icon('x')}</button></div>
        ${thread.adminsOnly ? '<div class="note warn small" style="margin:8px 12px 0">Only admins can send in this group.</div>' : ''}
        <div class="bar">
          <button class="icon-btn" data-attach title="Attach a photo, video or document">${icon('clip')}</button>
          <input type="file" data-file class="hidden" accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip">
          <textarea rows="1" data-text placeholder="Type a message" aria-label="Message"></textarea>
          <button class="send-btn" data-send aria-label="Send" disabled>${icon('send')}</button>
        </div>`;
      const ta = c.querySelector('[data-text]'), sendBtn = c.querySelector('[data-send]');
      const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; sendBtn.disabled = !ta.value.trim() || sending; };
      ta.addEventListener('input', grow);
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); sendText(); }
      });
      ta.addEventListener('paste', e => {
        const f = [...(e.clipboardData?.files || [])][0];
        if (f) { e.preventDefault(); previewFile(f); }
      });
      sendBtn.onclick = sendText;
      c.querySelector('[data-attach]').onclick = () => c.querySelector('[data-file]').click();
      c.querySelector('[data-file]').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) previewFile(f); };
      c.querySelector('[data-noreply]').onclick = () => setReply(null);
      if (!coarse) ta.focus();
    }
    function setReply(m) {
      replyTo = m;
      const box = threadEl.querySelector('[data-replying]');
      if (!box) return;
      box.classList.toggle('hidden', !m);
      if (m) {
        box.querySelector('[data-q]').textContent = `${m.fromMe ? 'You' : m.sender || ''}: ${m.text || (m.media ? `[${m.media.kind}]` : '')}`;
        threadEl.querySelector('[data-text]')?.focus();
      }
    }

    // ------------------------------------------------------------ messages
    function mediaHtml(m) {
      const md = m.media;
      if (!md) return '';
      const thumb = md.thumb ? `<img alt="" src="data:image/jpeg;base64,${esc(md.thumb)}">` : '';
      if (md.kind === 'image' || md.kind === 'sticker') return `<div class="media" data-media="${md.kind}">${thumb || `<div class="ph">${icon('image')}</div>`}</div>`;
      if (md.kind === 'video') return `<div class="media" data-media="video">${thumb || `<div class="ph"></div>`}<div class="play"><span>${icon('play')}</span></div></div>`;
      if (md.kind === 'audio') return `<div class="file" data-media="audio">${icon('mic')}<div class="fn">Voice note${md.seconds ? ` · ${Math.floor(md.seconds / 60)}:${String(md.seconds % 60).padStart(2, '0')}` : ''}</div>${icon('play', 'sm')}</div>`;
      const size = md.size ? ` · ${md.size > 1048576 ? `${(md.size / 1048576).toFixed(1)} MB` : `${Math.ceil(md.size / 1024)} KB`}` : '';
      return `<div class="file" data-media="document">${icon('doc')}<div style="min-width:0"><div class="fn">${esc(md.fileName || 'Document')}</div><div class="small muted">${esc((md.mimetype || '').split('/').pop())}${size}</div></div>${icon('download', 'sm')}</div>`;
    }
    function msgHtml(m, prev) {
      const first = !prev || prev.fromMe !== m.fromMe || prev.senderJid !== m.senderJid || dayKey(prev.ts) !== dayKey(m.ts);
      const sep = !prev || dayKey(prev.ts) !== dayKey(m.ts) ? `<div class="day-sep" data-day="${dayKey(m.ts)}">${esc(dayLabel(m.ts))}</div>` : '';
      const who = thread.isGroup && !m.fromMe && first ? `<div class="snd" style="color:${senderColor(m.senderJid)}">${esc(m.sender || '')}${m.ours ? ' <span class="pill" style="height:17px;font-size:10.5px">our side</span>' : ''}</div>` : '';
      const quote = m.quoted ? `<div class="quote" data-goto="${esc(m.quoted.id)}">${esc(m.quoted.text || 'Message')}</div>` : '';
      const text = m.text ? `<span class="txt">${waFormat(m.text)}</span>` : '';
      return `${sep}<div class="m ${m.fromMe ? 'sent' : 'recv'} ${first ? 'first' : ''}" data-id="${esc(keyOf(m))}">
        <div class="bub">${who}${quote}${mediaHtml(m)}${text}<span class="meta">${esc(time(m.ts))}${m.fromMe ? `<span data-tick>${tick(m.status)}</span>` : ''}</span>
        <button class="icon-btn ract" data-reply title="Reply">${icon('reply', 'sm')}</button></div></div>`;
    }
    const senderColors = new Map();
    function senderColor(jid) {
      if (!senderColors.has(jid)) {
        const pal = ['#1f7aec', '#e54c6c', '#00a884', '#a05ce8', '#d9822b', '#0ea5a4', '#c2410c', '#6d28d9'];
        let h = 0; for (const c of String(jid)) h = (h * 33 + c.charCodeAt(0)) >>> 0;
        senderColors.set(jid, pal[h % pal.length]);
      }
      return senderColors.get(jid);
    }
    function renderAll(keepAnchor) {
      const m = msgsEl();
      const prevH = m.scrollHeight, prevTop = m.scrollTop;
      rendered.clear();
      const list = thread.messages;
      if (!list.length) { m.innerHTML = '<div class="empty">No messages in this chat yet.</div>'; return; }
      const older = list.length >= limit ? `<button class="btn sm older" data-older>Load older messages</button>` : '';
      m.innerHTML = older + list.map((x, i) => msgHtml(x, list[i - 1])).join('');
      m.querySelectorAll('.m[data-id]').forEach(el => rendered.set(el.dataset.id, { el, status: list.find(x => keyOf(x) === el.dataset.id)?.status }));
      m.querySelector('[data-older]')?.addEventListener('click', loadOlder);
      bindImages(m);
      if (keepAnchor) m.scrollTop = m.scrollHeight - prevH + prevTop;
      else scrollBottom(false);
    }
    // Late-loading pictures change heights; stay pinned to the bottom when we were there.
    function bindImages(scope) {
      scope.querySelectorAll('img').forEach(img => {
        if (img.complete) return;
        const pinned = nearBottom();
        img.addEventListener('load', () => { if (pinned) scrollBottom(false); }, { once: true });
      });
    }
    function applyUpdate(next) {
      const m = msgsEl();
      const oldIds = thread.messages.map(keyOf);
      const nextIds = new Set(next.messages.map(keyOf));
      const continuous = oldIds.length && oldIds.every(id => nextIds.has(id)) && next.messages[0] && keyOf(next.messages[0]) === oldIds[0];
      const wasNear = nearBottom();
      if (!continuous) { thread = next; renderAll(!wasNear); return; }
      const byId = new Map(next.messages.map(x => [keyOf(x), x]));
      // Ticks change in place.
      for (const [id, r] of rendered) {
        const x = byId.get(id);
        if (x && x.fromMe && x.status !== r.status) {
          const t = r.el.querySelector('[data-tick]');
          if (t) t.innerHTML = tick(x.status);
          r.status = x.status;
        }
      }
      // New messages are appended.
      const known = new Set(oldIds);
      const fresh = next.messages.filter(x => !known.has(keyOf(x)));
      m.querySelectorAll('[data-temp]').forEach(el => { if (fresh.some(x => x.id === el.dataset.real) || fresh.some(x => x.fromMe)) el.remove(); });
      let prev = thread.messages[thread.messages.length - 1];
      let mine = false;
      for (const x of fresh) {
        const tmp = document.createElement('div');
        tmp.innerHTML = msgHtml(x, prev);
        for (const el of [...tmp.children]) { m.append(el); if (el.dataset.id) rendered.set(el.dataset.id, { el, status: x.status }); }
        bindImages(m.lastElementChild || m);
        prev = x;
        if (x.fromMe) mine = true;
      }
      thread = next;
      if (fresh.length) {
        if (wasNear || mine) scrollBottom(false);
        else { unseen += fresh.filter(x => !x.fromMe).length; updateBottomBtn(); }
        markSeen();
      }
    }
    async function loadThread(first) {
      if (!open) return;
      const key = `${open.instance}|${open.jid}`;
      const next = await get(`/api/chats/${encodeURIComponent(open.instance)}/${encodeURIComponent(open.jid)}?limit=${limit}`);
      if (destroyed || !open || key !== `${open.instance}|${open.jid}`) return;
      if (first || !thread) {
        thread = next;
        renderHead(); renderComposer(); renderAll(false); markSeen();
      } else {
        const stateChanged = next.state !== thread.state;
        applyUpdate(next);
        if (stateChanged) { renderHead(); renderComposer(); }
      }
    }
    async function loadOlder() {
      if (loadingOlder || !thread) return;
      loadingOlder = true;
      try {
        limit = Math.min(limit + 150, 600);
        const next = await get(`/api/chats/${encodeURIComponent(open.instance)}/${encodeURIComponent(open.jid)}?limit=${limit}`);
        thread = next;
        renderAll(true);
      } catch (e) { fail(e); } finally { loadingOlder = false; }
    }
    const markSeen = debounce(() => {
      if (!thread?.messages.length) return;
      const ts = thread.messages[thread.messages.length - 1].ts;
      post(`/api/chats/${encodeURIComponent(thread.instance)}/${encodeURIComponent(thread.jid)}/seen`, { ts }).then(() => {
        for (const c of chats) if (c.jid === thread.jid) c.unread = 0;
        renderList();
      }).catch(() => {});
    }, 400);

    function onMsgClick(e) {
      const el = e.target.closest('.m');
      const msg = el && thread.messages.find(x => keyOf(x) === el.dataset.id);
      if (e.target.closest('[data-reply]') && msg) return setReply(msg);
      const g = e.target.closest('[data-goto]');
      if (g) {
        const t = msgsEl().querySelector(`.m[data-id="${CSS.escape(`${g.dataset.goto}:i`)}"], .m[data-id="${CSS.escape(`${g.dataset.goto}:o`)}"]`);
        if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
        else toast('That message is further back. Load older messages to see it.');
        return;
      }
      const md = e.target.closest('[data-media]');
      if (md && msg) openMedia(msg, md);
      if (e.target.closest('a')) e.stopPropagation();
    }
    async function openMedia(msg, el) {
      const kind = el.dataset.media;
      try {
        const blob = await fetchBlob(`/api/media/${encodeURIComponent(thread.instance)}/${encodeURIComponent(msg.id)}`);
        const url = URL.createObjectURL(blob);
        if (kind === 'image' || kind === 'sticker') { const img = new Image(); img.src = url; img.alt = ''; lightbox(img); }
        else if (kind === 'video') { const v = document.createElement('video'); v.src = url; v.controls = true; v.autoplay = true; lightbox(v); }
        else if (kind === 'audio') { const a = document.createElement('audio'); a.src = url; a.controls = true; a.autoplay = true; el.replaceWith(a); }
        else {
          const a = document.createElement('a');
          a.href = url; a.download = msg.media?.fileName || 'document';
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
      } catch (e) { fail(e); }
    }

    // ------------------------------------------------------------ sending
    function tempBubble(text) {
      const m = msgsEl();
      m.querySelector('.empty')?.remove();
      const d = document.createElement('div');
      d.className = 'm sent first';
      d.dataset.temp = '1';
      d.innerHTML = `<div class="bub"><span class="txt">${waFormat(text)}</span><span class="meta">${esc(time(Date.now()))}<span data-tick>${tick('PENDING')}</span></span></div>`;
      m.append(d);
      scrollBottom(false);
      return d;
    }
    async function sendText() {
      const ta = threadEl.querySelector('[data-text]');
      const text = ta?.value.trim();
      if (!text || sending) return;
      sending = true;
      const body = { text, quotedId: replyTo?.id };
      ta.value = ''; ta.style.height = 'auto';
      threadEl.querySelector('[data-send]').disabled = true;
      const t = tempBubble(text);
      setReply(null);
      try {
        const r = await post(`/api/chats/${encodeURIComponent(thread.instance)}/${encodeURIComponent(thread.jid)}/send`, body);
        t.dataset.real = r.id || '';
        await loadThread(false);
      } catch (e) {
        t.querySelector('[data-tick]').innerHTML = tick('ERROR');
        t.title = e.message;
        ta.value = text;
        fail(e);
      } finally {
        sending = false;
        if (ta.isConnected) { ta.dispatchEvent(new Event('input')); ta.focus(); }
      }
    }
    function previewFile(file) {
      if (!canSend()) return toast('This number cannot send here.', 'bad');
      if (file.size > MAX_FILE) return toast('Files up to 16 MB can be sent.', 'bad');
      const kind = /^image\/(jpeg|png|webp|gif)$/.test(file.type) ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document';
      const url = URL.createObjectURL(file);
      const prev = kind === 'image' ? `<img src="${url}" alt="" style="max-width:100%;max-height:50vh;border-radius:8px;display:block;margin:0 auto">`
        : kind === 'video' ? `<video src="${url}" controls style="max-width:100%;max-height:50vh;display:block;margin:0 auto"></video>`
        : `<div class="row">${icon('doc')}<div><b>${esc(file.name)}</b><div class="small muted">${(file.size / 1024).toFixed(0)} KB</div></div></div>`;
      modal({
        title: `Send ${kind === 'document' ? 'a document' : `a ${kind}`} to ${thread.name}`,
        body: `${prev}${kind === 'audio' ? '' : `<label class="f" style="margin-top:14px"><span>Caption</span><input class="in" data-cap maxlength="1024" placeholder="Add a caption (optional)"></label>`}
          <div class="help" style="margin-top:8px">Sent from ${esc(numberOf(thread.instance)?.label || '')}.</div>`,
        onClose: () => URL.revokeObjectURL(url),
        actions: [{ label: 'Cancel' }, {
          label: 'Send', kind: 'primary', onClick: async ctl => {
            const caption = ctl.body.querySelector('[data-cap]')?.value || '';
            const base64 = await fileToBase64(file);
            await post(`/api/chats/${encodeURIComponent(thread.instance)}/${encodeURIComponent(thread.jid)}/send-media`,
              { mediatype: kind, mimetype: file.type || 'application/octet-stream', base64, caption, fileName: file.name, quotedId: replyTo?.id });
            setReply(null);
            toast('Sent');
            await loadThread(false);
          },
        }],
      });
    }

    // ------------------------------------------------------------ routing inside the page
    async function openFromArgs(a) {
      if (a.length >= 2) {
        const next = { instance: a[0], jid: a.slice(1).join('/') };
        if (!open || open.instance !== next.instance || open.jid !== next.jid) {
          open = next; thread = null; limit = 120; replyTo = null; unseen = 0;
          wrap.classList.add('show-thread');
          threadShell();
          renderList();
          await loadThread(true).catch(e => { fail(e); msgsEl().innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
        }
      } else {
        open = null; thread = null;
        wrap.classList.remove('show-thread');
        renderList();
      }
    }
    function startThreadTimer() {
      clearInterval(threadTimer);
      threadTimer = setInterval(() => { if (!document.hidden && open) loadThread(false).catch(() => {}); }, 3500);
    }

    return {
      refreshMs: 8000, refreshWhileTyping: true,
      async load() { await loadList(); await openFromArgs(args); startThreadTimer(); },
      async refresh() { await loadList(); },
      onArgs(a) { openFromArgs(a).catch(fail); },
      destroy() { destroyed = true; clearInterval(threadTimer); },
    };
  },
};
