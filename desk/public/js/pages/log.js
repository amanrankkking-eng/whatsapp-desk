// Everything the desk did and who did it, newest first.
import { get, esc, dateTime } from '../core.js';

export default {
  id: 'log', title: 'Activity log', icon: 'log',
  create({ view }) {
    let filter = '';
    async function render() {
      const ev = await get('/api/events?limit=500');
      const kinds = [...new Set(ev.map(e => e.kind))].sort();
      const list = ev.filter(e => !filter || e.kind === filter);
      view.innerHTML = `<div class="page wide">
        <div class="row" style="margin-bottom:10px"><select class="in sm" data-k style="width:auto"><option value="">Everything (${ev.length})</option>
          ${kinds.map(k => `<option ${k === filter ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>What</th><th>Who</th><th>Details</th></tr></thead><tbody>
        ${list.map(e => `<tr><td class="small nowrap">${esc(dateTime(e.ts))}</td><td class="mono">${esc(e.kind)}</td><td class="small">${esc(e.who || 'system')}</td>
          <td class="mono small" style="max-width:640px;overflow-wrap:anywhere">${esc(JSON.stringify(e.detail || {}))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>'}
        </tbody></table></div></div>`;
      view.querySelector('[data-k]').onchange = x => { filter = x.target.value; render(); };
    }
    return { load: render, refresh: render, refreshMs: 30000 };
  },
};
