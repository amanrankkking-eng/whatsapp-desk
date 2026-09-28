# Adding features

The desk is plain Node.js (no framework), Postgres and vanilla JavaScript modules in the browser. There is no build step, so every file you see is the file that runs.

## Where things live

| File | What it does |
|---|---|
| `desk/src/server.mjs` | HTTP routes, security guards, background jobs, and plugin loading |
| `desk/src/db.mjs` | The `desk` schema, created and updated at start, and the views over Evolution's messages |
| `desk/src/numbers.mjs` | WhatsApp numbers: add, link (QR or code), roles, groups and members, who is on our side |
| `desk/src/chats.mjs` | The inbox: chat lists, threads, ticks, sending text and media |
| `desk/src/resellers.mjs` | Leads, calls, statuses, closing and reopening rows, binding by hand, moving a slice |
| `desk/src/bind.mjs` | Stage 2: binding a group to its reseller by phone number; batch placement |
| `desk/src/read.mjs` | Stages 3, 4 and 11: the read, the ring read from the chat, and replies |
| `desk/src/plan.mjs` | Stages 4–7: today's batches, the six checks, tags, the preview, and approval |
| `desk/src/runner.mjs` | Stages 7–8: sending the approved queue per number, recording, stopping, rest days |
| `desk/src/reports.mjs` | Stage 9 summaries and the Stage 11 owner alerts in Google Chat |
| `desk/src/ladder.mjs` | Message ladders, rate card, heading styles, and rendering a message |
| `desk/src/settings.mjs` | Every rule's number, with its default |
| `desk/public/js/pages/*.js` | One file per dashboard page |
| `desk/public/js/core.js` | Shared browser helpers: API calls, formatting, dialogs, toasts |

## A server-side plugin (no core change)

Put a `.mjs` file in `desk/src/plugins/`. Every file there that exports `register` is loaded when the desk starts:

```js
// desk/src/plugins/daily-count.mjs
export async function register({ route, every, q, one, logEvent, getSettings, cfg }) {
  // A new API route. Paths without /api/ are mounted under /api/plugins/...
  route('GET', '/daily-count', async () => q(`select sent_at::date as day, count(*)::int as n from desk.send_log group by 1 order by 1 desc`));

  // A background job. It shows on the Overview page, and POST /api/run-worker/daily-count runs it once.
  every(60 * 60 * 1000, 'daily-count', async () => {
    const r = await one(`select count(*)::int n from desk.send_log where sent_at > now() - interval '1 day'`);
    await logEvent('plugin.daily-count', r);
    return r;
  });
}
```

Plugin routes get the same guards as every other route: login, same-origin, and the `x-desk` header on changes.
A plugin that throws while loading is logged and skipped; the desk still starts.

## A new page in the dashboard

1. Create `desk/public/js/pages/<name>.js`:

   ```js
   import { get, esc } from '../core.js';
   export default {
     id: 'daily', title: 'Daily count', icon: 'report',
     create({ view }) {
       async function load() {
         const rows = await get('/api/plugins/daily-count');
         view.innerHTML = `<div class="page">${rows.map(r => `<div>${esc(r.day)}: ${r.n}</div>`).join('')}</div>`;
       }
       return { load, refresh: load, refreshMs: 60000 };
     },
   };
   ```

2. Add it to the list in `desk/public/js/pages/index.js`.

`icon` is the name of a symbol in `public/index.html` (`#i-<name>`). `refresh` runs every `refreshMs`. It is skipped while someone is typing in the page or a dialog is open, so auto-refresh never loses someone's input.
Always pass text from WhatsApp or the database through `esc()` before putting it into HTML.

## Tests and the demo

```bash
cd desk
npm install
TEST_ADMIN_DB_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm test
```

The test creates a throwaway `desk_test` database and starts a mock Evolution API (`test/mock-evolution.mjs`). It then walks Stage 0 to Stage 12 on a fake clock. Add a test next to it for anything you add.

`node test/demo.mjs` starts a full demo on http://localhost:8093 (user `demo`, password `demo-pass-1`): four numbers, resellers, a long chat, replies and alerts, and nothing real. Use it to try a change in the browser.

## Rules that must survive any change

- The desk never replies to anyone by itself. Nothing sends without a person's approval of the named list, or a person pressing Send in the inbox.
- The reader number never sends.
- Groups whose names are on the never-send list, or contain an excluded word (`01wire`), are never bound and never messaged.
- `desk.send_log` and `desk.replies` are append-only. Never update or delete their rows.
