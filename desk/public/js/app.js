// The app shell: login, navigation, routing and the live badges.
import { api, get, bus, esc, icon, toast, fail, anyOverlayOpen, ApiError } from './core.js';
import { PAGES } from './pages/index.js';
import { openAddWhatsApp } from './pages/numbers.js';

const root = document.getElementById('root');
let me = null, current = null, currentId = null, refreshTimer = null, badgeTimer = null;

// ---------------------------------------------------------------- theme
const THEME_KEY = 'desk-theme';
function applyTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch {}
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  try { localStorage.setItem(THEME_KEY, dark ? 'light' : 'dark'); } catch {}
  applyTheme();
}
applyTheme();

// ---------------------------------------------------------------- errors in this page
// A page that breaks is recorded on the Health page like a server error (at most five a load).
let reportedErrors = 0;
function reportError(message, stack, where) {
  if (reportedErrors >= 5 || !me) return;
  reportedErrors++;
  fetch('/api/client-error', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-desk': '1' },
    body: JSON.stringify({ message: String(message || 'unknown').slice(0, 500), stack: String(stack || '').slice(0, 3000), where, page: location.hash, agent: navigator.userAgent }) }).catch(() => {});
}
window.addEventListener('error', e => {
  if (e.filename && !e.filename.startsWith(location.origin)) return;       // browser extensions
  reportError(e.message, e.error?.stack, e.filename ? `${e.filename.replace(location.origin, '')}:${e.lineno}` : '');
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  if (r instanceof ApiError) return;                                        // already shown as a toast
  reportError(r?.message || String(r), r?.stack, '');
});

// ---------------------------------------------------------------- login
function showLogin(msg) {
  stopTimers();
  root.innerHTML = `<div class="login"><form autocomplete="on">
    <h1><span class="brand-logo">${icon('chat')}</span> WhatsApp Desk</h1>
    <div class="muted small">Sign in to manage your WhatsApp numbers.</div>
    ${msg ? `<div class="note bad">${esc(msg)}</div>` : ''}
    <label class="f"><span>Username</span><input class="in" name="user" autocomplete="username" required></label>
    <label class="f"><span>Password</span><input class="in" name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary block" type="submit">Sign in</button></form></div>`;
  const form = root.querySelector('form');
  form.user.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', '/api/login', { user: form.user.value.trim(), password: form.password.value });
      await boot();
    } catch (err) { showLogin(err.message); }
  };
}
bus.on('auth-required', () => { if (!root.querySelector('.login')) showLogin('Your session ended. Please sign in again.'); });

// ---------------------------------------------------------------- shell
function shell() {
  root.innerHTML = `<div class="app">
    <aside class="side">
      <div class="brand"><span class="brand-logo">${icon('chat')}</span><div>WhatsApp Desk<small>${esc(me.test ? 'TEST MODE' : `v${me.version}`)}</small></div></div>
      <nav class="nav">${PAGES.filter(p => !p.hidden).map(p => `<a href="#/${p.id}" data-page="${p.id}">${icon(p.icon)}<span>${esc(p.title)}</span><span class="badge hidden" data-badge="${p.id}"></span></a>`).join('')}</nav>
      <div class="side-foot">
        <button class="btn primary block" data-add-wa>${icon('plus')} Add WhatsApp</button>
        <div class="row"><button class="icon-btn" data-theme title="Light or dark">${icon('moon')}</button>
          <span class="spacer small muted">${esc(me.user || '')}</span>
          ${me.authRequired ? `<button class="icon-btn" data-logout title="Sign out">${icon('logout')}</button>` : ''}</div>
      </div>
    </aside>
    <div class="scrim"></div>
    <main class="main">
      <header class="topbar"><button class="icon-btn menu-btn" data-menu aria-label="Menu">${icon('menu')}</button>
        <h1 id="title"></h1><div class="grow"></div><div id="top-actions" class="row"></div></header>
      <section class="view" id="view"></section>
    </main></div>`;
  const app = root.querySelector('.app');
  root.querySelector('[data-menu]').onclick = () => app.classList.add('nav-open');
  root.querySelector('.scrim').onclick = () => app.classList.remove('nav-open');
  root.querySelector('.nav').addEventListener('click', () => app.classList.remove('nav-open'));
  root.querySelector('[data-add-wa]').onclick = () => { app.classList.remove('nav-open'); openAddWhatsApp(() => bus.emit('numbers-changed')); };
  root.querySelector('[data-theme]').onclick = toggleTheme;
  root.querySelector('[data-logout]')?.addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); showLogin(); });
}

// ---------------------------------------------------------------- routing
function parseHash() {
  const [id, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { id: id || 'overview', args: rest.map(decodeURIComponent) };
}
async function route() {
  const { id, args } = parseHash();
  const page = PAGES.find(p => p.id === id) || PAGES[0];
  const view = document.getElementById('view');
  if (!view) return;
  root.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page.id));
  if (currentId === page.id && current?.onArgs) { current.onArgs(args); return; }
  current?.destroy?.();
  clearInterval(refreshTimer);
  currentId = page.id;
  document.getElementById('title').textContent = page.title;
  document.getElementById('top-actions').innerHTML = '';
  view.className = `view ${page.full ? 'full' : ''}`;
  view.innerHTML = '';
  view.scrollTop = 0;
  current = page.create({ view, args, actions: document.getElementById('top-actions'), me });
  try { await current.load?.(); } catch (e) { fail(e); }
  if (current.refreshMs) {
    refreshTimer = setInterval(async () => {
      // Never redraw under someone who is typing or has a dialog open.
      const active = document.activeElement;
      if (document.hidden || anyOverlayOpen() || (active && view.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName) && !current.refreshWhileTyping)) return;
      const top = view.scrollTop;
      try { await current.refresh?.(); } catch {}
      if (!page.full) view.scrollTop = top;
    }, current.refreshMs);
  }
}
window.addEventListener('hashchange', route);

async function badges() {
  try {
    const o = await get('/api/overview');
    const set = (id, n, red) => {
      const b = root.querySelector(`[data-badge="${id}"]`);
      if (!b) return;
      b.textContent = n; b.classList.toggle('hidden', !n); b.classList.toggle('red', !!red);
    };
    set('alerts', o.openAlerts, true);
    set('attention', o.bindIssues + o.needsStatus, true);
    set('numbers', o.numbers.filter(n => n.active && n.state !== 'open').length, true);
    set('health', o.openErrors, true);
    bus.emit('overview', o);
  } catch {}
}
function stopTimers() { clearInterval(refreshTimer); clearInterval(badgeTimer); current?.destroy?.(); current = null; currentId = null; }

async function boot() {
  try { me = await get('/api/me'); } catch (e) { root.innerHTML = `<div class="boot">${esc(e.message)}</div>`; return; }
  if (me.authRequired && !me.user) return showLogin();
  shell();
  await route();
  badges();
  badgeTimer = setInterval(badges, 20000);
  let t;
  bus.on('numbers-changed', badges);
  bus.on('changed', () => { clearTimeout(t); t = setTimeout(badges, 600); });
}
boot();
export { toast };
