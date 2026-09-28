// Shared helpers for every page: the API client, escaping, formatting, toasts, modals.
const TZ = 'Asia/Kolkata';

// ---------------------------------------------------------------- events
const listeners = {};
export const bus = {
  on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => listeners[ev].delete(fn); },
  emit(ev, data) { for (const fn of listeners[ev] || []) fn(data); },
};

// ---------------------------------------------------------------- API
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-desk': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError('The dashboard server is not answering. Check that it is running.', 0); }
  if (res.status === 401 && !path.startsWith('/api/login')) bus.emit('auth-required');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  // Any change can move a menu badge (alerts, attention, numbers).
  if (method !== 'GET' && !path.endsWith('/seen')) bus.emit('changed');
  return data;
}
export const get = p => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);

// ---------------------------------------------------------------- text
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const icon = (name, cls = '') => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;

// WhatsApp formatting on already-escaped text: ```code```, *bold*, _italic_, ~strike~, links, @mentions.
export function waFormat(raw) {
  let s = esc(raw);
  s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<b>$2</b>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?:;])/g, '$1<s>$2</s>');
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/(^|\s)@(\d{6,15})\b/g, '$1<span class="mention">@$2</span>');
  return s;
}

// ---------------------------------------------------------------- time (always India time)
const fmt = (opts) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...opts });
const F_TIME = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const F_DAY = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
const F_WEEKDAY = fmt({ weekday: 'long' });
const F_LONG = fmt({ day: 'numeric', month: 'long', year: 'numeric' });
const F_SHORT = fmt({ day: '2-digit', month: '2-digit', year: '2-digit' });
const F_DT = fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const toDate = v => (v instanceof Date ? v : typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v));
export const dayKey = v => F_DAY.format(toDate(v));
export const time = v => (v ? F_TIME.format(toDate(v)) : '');
export const dateTime = v => (v ? F_DT.format(toDate(v)) : '—');
export function dayLabel(v) {
  const d = toDate(v), k = dayKey(d), today = dayKey(new Date()), y = dayKey(new Date(Date.now() - 86400000));
  if (k === today) return 'Today';
  if (k === y) return 'Yesterday';
  if (Date.now() - d.getTime() < 6 * 86400000) return F_WEEKDAY.format(d);
  return F_LONG.format(d);
}
export function listTime(v) {
  const d = toDate(v), k = dayKey(d);
  if (k === dayKey(new Date())) return F_TIME.format(d);
  if (k === dayKey(new Date(Date.now() - 86400000))) return 'Yesterday';
  if (Date.now() - d.getTime() < 6 * 86400000) return F_WEEKDAY.format(d);
  return F_SHORT.format(d);
}
export function ago(v) {
  if (!v) return 'never';
  const s = Math.max(0, (Date.now() - toDate(v).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
export const niceDate = v => (v ? F_LONG.format(toDate(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00+05:30` : v)) : '—');
export const phoneFmt = p => (p ? `+${p}` : '');
export const plural = (n, w, pl) => `${n} ${n === 1 ? w : pl || `${w}s`}`;

// ---------------------------------------------------------------- colours
const PALETTE = ['#00a884', '#7f66ff', '#ff8b3d', '#0da2ff', '#e4468b', '#35b25e', '#c45c9a', '#a17d00', '#5b7fff', '#d95c3c'];
export function colorOf(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const numberColor = n => PALETTE[((n?.sort || 1) - 1) % PALETTE.length];
export function initials(name) {
  const w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}
export function avatar(name, key, isGroup, cls = '') {
  return `<div class="av ${cls}" style="background:${colorOf(key || name)}">${isGroup ? icon('group') : esc(initials(name))}</div>`;
}

// ---------------------------------------------------------------- ticks
export function tick(status) {
  switch (status) {
    case 'READ': case 'PLAYED': return `<span class="tk read" title="Read">${icon('dcheck')}</span>`;
    case 'DELIVERY_ACK': return `<span class="tk" title="Delivered">${icon('dcheck')}</span>`;
    case 'SERVER_ACK': return `<span class="tk" title="Sent">${icon('check')}</span>`;
    case 'ERROR': return `<span class="tk err" title="Not sent">!</span>`;
    default: return `<span class="tk pend" title="Sending">${icon('clock')}</span>`;
  }
}

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}
export const fail = e => toast(e?.message || String(e), 'bad');

// ---------------------------------------------------------------- modals
const openStack = [];
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openStack.length) openStack[openStack.length - 1].close(); });
export const anyOverlayOpen = () => openStack.length > 0;

// body: HTML string. actions: [{ label, kind: 'primary'|'danger', onClick(ctl) -> false keeps it open }]
export function modal({ title, body = '', actions = [{ label: 'Close' }], wide = false, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="mh"><h3>${esc(title)}</h3><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div>
    <div class="mb"></div><div class="mf"></div></div>`;
  const mb = wrap.querySelector('.mb'), mf = wrap.querySelector('.mf');
  if (typeof body === 'string') mb.innerHTML = body; else mb.append(body);
  const ctl = {
    el: wrap, body: mb,
    close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      openStack.splice(openStack.indexOf(ctl), 1);
      onClose?.();
    },
    setActions(list) {
      mf.innerHTML = '';
      mf.classList.toggle('hidden', !list.length);
      for (const a of list) {
        const b = document.createElement('button');
        b.className = `btn ${a.kind || ''}`;
        b.textContent = a.label;
        if (a.disabled) b.disabled = true;
        b.onclick = async () => {
          if (!a.onClick) return ctl.close();
          b.disabled = true;
          try { if ((await a.onClick(ctl)) !== false) ctl.close(); } catch (e) { fail(e); } finally { b.disabled = false; }
        };
        mf.append(b);
      }
    },
  };
  ctl.setActions(actions);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) ctl.close(); });
  wrap.querySelector('[data-x]').onclick = () => ctl.close();
  document.body.append(wrap);
  openStack.push(ctl);
  setTimeout(() => wrap.querySelector('input:not([type=checkbox]), textarea, select')?.focus(), 30);
  return ctl;
}
export function confirmBox(title, text, { ok = 'Yes', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    modal({ title, body: `<p style="margin:0;white-space:pre-wrap">${esc(text)}</p>`,
      actions: [{ label: 'Cancel', onClick: () => { done = true; resolve(false); } },
        { label: ok, kind: danger ? 'danger solid' : 'primary', onClick: () => { done = true; resolve(true); } }],
      onClose: () => { if (!done) resolve(false); } });
  });
}
export function drawer({ title, render, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'drawer-wrap';
  wrap.innerHTML = `<div class="drawer"><div class="dh"><h3></h3><button class="icon-btn" data-x aria-label="Close">${icon('x')}</button></div><div class="db"></div></div>`;
  const ctl = {
    el: wrap, body: wrap.querySelector('.db'),
    setTitle(t) { wrap.querySelector('h3').textContent = t; },
    close() { if (!wrap.isConnected) return; wrap.remove(); openStack.splice(openStack.indexOf(ctl), 1); onClose?.(); },
  };
  ctl.setTitle(title || '');
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) ctl.close(); });
  wrap.querySelector('[data-x]').onclick = () => ctl.close();
  document.body.append(wrap);
  openStack.push(ctl);
  render?.(ctl);
  return ctl;
}
export function lightbox(node) {
  const w = document.createElement('div');
  w.className = 'lightbox';
  w.innerHTML = `<button class="icon-btn x" aria-label="Close">${icon('x')}</button>`;
  w.append(node);
  const ctl = { close() { w.remove(); openStack.splice(openStack.indexOf(ctl), 1); if (node.src?.startsWith('blob:')) URL.revokeObjectURL(node.src); } };
  w.addEventListener('click', e => { if (e.target === w || e.target.closest('.x')) ctl.close(); });
  document.body.append(w);
  openStack.push(ctl);
}

// ---------------------------------------------------------------- misc
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export function download(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.append(a); a.click(); a.remove();
}
export async function fetchBlob(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new ApiError((await r.json().catch(() => null))?.error || 'Could not load the file', r.status);
  return r.blob();
}
export const fileToBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read the file'));
  r.readAsDataURL(file);
});
export const STAGE_PILL = {
  new: '', called_1: 'info', offer_sent: 'info', live: 'ok', active_reseller: 'accent', not_interested: 'warn',
  dnc: 'bad', exhausted: 'warn', invalid: 'bad',
};
export const stateLabel = s => ({ open: 'Connected', connecting: 'Waiting for scan', close: 'Logged out', missing: 'Missing in Evolution', unreachable: 'Evolution not answering' }[s] || s || 'Unknown');
// A shared, lightly cached list of numbers for dropdowns and chips.
let numbersCache = { at: 0, list: [] };
export async function numbersList(force = false) {
  if (!force && Date.now() - numbersCache.at < 8000) return numbersCache.list;
  numbersCache = { at: Date.now(), list: await get('/api/numbers') };
  return numbersCache.list;
}
export function numberChip(n) {
  if (!n) return '';
  return `<span class="chip-n" style="background:${numberColor(n)}">${esc(n.label)}</span>`;
}
