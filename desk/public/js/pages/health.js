// Health: is the server fine, which number dropped and why, which job is failing, and every
// error the code hit, grouped, with its stack trace and a button to mark it fixed.
import { get, post, esc, icon, toast, fail, modal, confirmBox, dateTime, ago, stateLabel } from '../core.js';

const JOBS = {
  read: 'Finds new groups, binds them, reads every group, sets statuses, catches replies',
  sender: 'Sends the approved queue, one message at a time per number',
  alerts: 'Tells owners about replies until they acknowledge',
  'day-close': 'Closes a day with nothing to send so the rings move on',
  monitor: 'Watches every number, Evolution API, the disk and the backups',
  cleanup: 'Removes expired logins and old fixed errors',
};
const bytes = b => (b == null ? '—' : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export default {
  id: 'health', title: 'Health', icon: 'pulse',
  create({ view }) {
    let showAll = false;
    async function load() {
      const [h, errors] = await Promise.all([get('/api/health'), get(`/api/errors?show=${showAll ? 'all' : 'open'}&limit=200`)]);
      const linked = h.numbers.filter(n => n.active);
      const up = linked.filter(n => n.state === 'open').length;
      view.innerHTML = `<div class="page wide">
        <div class="grid k4">
          <div class="card kpi"><div class="n" style="font-size:20px">${esc(uptime(h.uptimeSec))}</div><div class="l">Server up · v${esc(h.version)}</div></div>
          <div class="card kpi"><div class="n" style="font-size:20px;color:${h.evolution.ok ? 'inherit' : 'var(--danger)'}">${h.evolution.ok ? 'Answering' : 'Not answering'}</div><div class="l">Evolution API</div></div>
          <a class="card kpi" href="#/numbers"><div class="n" style="color:${up < linked.length ? 'var(--danger)' : 'inherit'}">${up}<span class="muted" style="font-size:16px"> / ${linked.length}</span></div><div class="l">Numbers connected</div></a>
          <div class="card kpi"><div class="n" style="color:${h.errors.open ? 'var(--danger)' : 'inherit'}">${h.errors.open}</div><div class="l">Open errors (${h.errors.last24h.total} in the last 24 h)</div></div>
        </div>

        <h2 class="sec">${icon('phone', 'sm')} Numbers</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Number</th><th>Phone</th><th>Role</th><th>State</th><th>Down since</th><th>Last disconnect</th></tr></thead><tbody>
          ${h.numbers.map(n => `<tr><td><b>${esc(n.label)}</b><div class="small muted mono">${esc(n.instance)}</div></td>
            <td class="small">${n.phone ? `+${esc(n.phone)}` : 'not linked'}</td><td class="small">${esc(n.role)}</td>
            <td class="nowrap"><span class="dot ${esc(n.state)}"></span> ${esc(stateLabel(n.state))}</td>
            <td class="small">${n.downSince ? esc(ago(n.downSince)) : '—'}</td>
            <td class="small">${n.lastDisconnect ? `${esc(n.lastDisconnect.reason)}${n.lastDisconnect.at ? `<div class="muted">${esc(dateTime(n.lastDisconnect.at))}</div>` : ''}` : '—'}</td></tr>`).join('')
            || '<tr><td colspan="6" class="empty">No numbers yet.</td></tr>'}
        </tbody></table></div>

        <h2 class="sec">Background jobs</h2>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Job</th><th>What it does</th><th>Every</th><th>Last finished</th><th>State</th></tr></thead><tbody>
          ${h.workers.map(w => `<tr><td><b>${esc(w.name)}</b></td><td class="small">${esc(JOBS[w.name] || '')}</td>
            <td class="small nowrap">${w.everyMs >= 3600000 ? `${w.everyMs / 3600000} h` : w.everyMs >= 60000 ? `${w.everyMs / 60000} min` : `${w.everyMs / 1000} s`}</td>
            <td class="small">${w.lastOk ? esc(ago(w.lastOk)) : '—'}</td>
            <td>${w.lastError ? `<span class="pill bad">failing${w.fails > 1 ? ` ×${w.fails}` : ''}</span> <span class="small muted">${esc(w.lastError.slice(0, 120))}</span>`
              : w.lastOk ? '<span class="pill ok">ok</span>' : '<span class="pill">waiting</span>'}</td></tr>`).join('')}
        </tbody></table></div>

        <div class="row" style="margin:22px 0 10px"><h2 class="sec" style="margin:0">Errors</h2><span class="spacer"></span>
          <label class="check small"><input type="checkbox" data-all ${showAll ? 'checked' : ''}> Show fixed ones too</label>
          ${h.errors.open ? `<button class="btn sm" data-fixall type="button">Mark all fixed</button>` : ''}</div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Last seen</th><th>Where</th><th>What went wrong</th><th class="num">Times</th><th>Version</th><th></th></tr></thead><tbody>
          ${errors.map(e => `<tr${e.resolved_at ? ' style="opacity:.55"' : ''}><td class="small nowrap">${esc(dateTime(e.last_at))}<div class="muted">first ${esc(ago(e.first_at))}</div></td>
            <td class="small"><b>${esc(e.source)}</b>${e.where_ ? `<div class="mono muted">${esc(e.where_)}</div>` : ''}</td>
            <td class="small" style="max-width:520px;overflow-wrap:anywhere">${esc(e.message)}${e.resolved_at ? `<div class="muted">fixed by ${esc(e.resolved_by || '—')} ${esc(ago(e.resolved_at))}</div>` : ''}</td>
            <td class="num">${e.count}</td><td class="small mono">${esc(e.version || '')}</td>
            <td class="nowrap"><button class="btn sm" data-detail="${e.id}" type="button">Details</button>
              ${e.resolved_at ? '' : `<button class="btn sm" data-fix="${e.id}" type="button">Mark fixed</button>`}</td></tr>`).join('')
            || `<tr><td colspan="6" class="empty">${showAll ? 'No errors recorded.' : 'No open errors. Everything the code ran lately worked.'}</td></tr>`}
        </tbody></table></div>

        <div class="grid k2" style="margin-top:18px">
          <div class="card"><div class="hd"><h3>Server</h3></div><div class="bd kv">
            <div>Version</div><div class="mono">${esc(h.version)}</div>
            <div>Started</div><div>${esc(dateTime(h.startedAt))}</div>
            <div>Node</div><div class="mono">${esc(h.node)}</div>
            <div>Memory (desk)</div><div>${esc(bytes(h.memory.rssBytes))}</div>
            <div>Memory free (server)</div><div>${esc(bytes(h.memory.systemFreeBytes))} of ${esc(bytes(h.memory.systemTotalBytes))}</div>
            <div>Disk</div><div>${h.disk ? `${h.disk.usedPct}% used · ${esc(bytes(h.disk.freeBytes))} free` : '—'}</div>
            <div>Database</div><div>${esc(bytes(h.databaseBytes))}</div>
            <div>Last backup</div><div>${h.lastBackup?.at ? esc(ago(h.lastBackup.at)) : 'none recorded (scripts/backup.sh records it)'}</div>
          </div></div>
          <div class="card"><div class="hd"><h3>Watching from outside</h3></div><div class="bd stack small">
            <div>The desk reports its own problems to the Google Chat space (Settings → Google Chat). If the whole server goes down it cannot report anything, so let an outside service check it too:</div>
            <div class="mono" style="overflow-wrap:anywhere">${esc(location.origin)}/healthz</div>
            <div>It answers 200 when the database and Evolution API answer, and 503 when one of them does not. A free UptimeRobot monitor (HTTP, every 5 minutes) that emails or messages you on a non-200 answer covers the rest.</div>
          </div></div>
        </div>
      </div>`;
      bind(errors);
    }
    function bind(errors) {
      view.querySelector('[data-all]').onchange = e => { showAll = e.target.checked; load().catch(fail); };
      view.querySelector('[data-fixall]')?.addEventListener('click', async () => {
        if (!await confirmBox('Mark all fixed', 'Mark every open error as fixed? One that happens again comes back as a new open error.', { ok: 'Mark fixed' })) return;
        try { await post('/api/errors/resolve-all'); toast('Marked fixed', 'ok'); await load(); } catch (e) { fail(e); }
      });
      view.querySelectorAll('[data-fix]').forEach(b => b.onclick = async () => {
        try { await post(`/api/errors/${b.dataset.fix}/resolve`); toast('Marked fixed', 'ok'); await load(); } catch (e) { fail(e); }
      });
      view.querySelectorAll('[data-detail]').forEach(b => b.onclick = async () => {
        try {
          const e = await get(`/api/errors/${b.dataset.detail}`);
          modal({ title: `Error #${e.id} · ${e.source}`, wide: true,
            body: `<div class="stack"><div class="kv small"><div>Where</div><div class="mono">${esc(e.where_ || '—')}</div>
                <div>Times</div><div>${e.count} (first ${esc(dateTime(e.first_at))}, last ${esc(dateTime(e.last_at))})</div>
                <div>Version</div><div class="mono">${esc(e.version || '—')}</div></div>
              <div><b class="small">Message</b><div class="small" style="overflow-wrap:anywhere">${esc(e.message)}</div></div>
              ${e.stack ? `<div><b class="small">Stack trace</b><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;margin:4px 0 0">${esc(e.stack)}</pre></div>` : ''}
              ${e.context && Object.keys(e.context).length ? `<div><b class="small">Context</b><pre class="mono small" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 0">${esc(JSON.stringify(e.context, null, 2))}</pre></div>` : ''}
              <div class="help">Ask Claude to fix it: give it this error id; with Claude access set up it can read the stack trace with the errors_recent tool.</div></div>`,
            actions: [{ label: 'Close' }, ...(e.resolved_at ? [] : [{ label: 'Mark fixed', kind: 'primary', onClick: async () => { await post(`/api/errors/${e.id}/resolve`); toast('Marked fixed', 'ok'); await load(); } }])] });
        } catch (err) { fail(err); }
      });
    }
    return { load, refresh: load, refreshMs: 30000 };
  },
};
