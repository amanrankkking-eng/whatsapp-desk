# WhatsApp Desk

One dashboard for several WhatsApp numbers on one Evolution API server, with the reseller follow-up flow
("Reseller Automation — Every Step, Start to End") built in.

- **Chats.** A WhatsApp-style inbox for every connected number, or all of them together. Reply, quote, and send photos, videos and documents. Ticks show ✓ sent, ✓✓ delivered and blue ✓✓ read, in groups too.
- **Numbers.** **Add WhatsApp** links a new number by QR or by pairing code. Each number has a role (one reader, several senders), a daily cap and a warm-up. A lost sender's groups can be moved to another sender.
- **Resellers.** Import leads, log calls in two taps, see each row's stage, ring, sender, group, last message and next turn. Close or reopen rows.
- **Today's sends.** The whole day as a preview: every group, the exact text, why that message, the tag, and every skip with its reason. Nothing sends until you approve the named list. Each sender then sends one message at a time with random 5–14 minute gaps, 10:30–17:30, Monday to Friday.
- **Replies & alerts.** A reseller's reply pauses that group at once and alerts its owner by name in Google Chat, repeating until someone acknowledges it. There is also a replies-by-day tracker for every group.
- **Needs a person.** Groups the desk could not bind, rows without a status, unreadable groups, and rejected leads.
- **Messages & rate card.** The two message ladders, the rate card they are built from, and the five heading styles, each with a live preview.
- **Reports.** The team summary and each owner's brief after every run, plus every run's sends and skips. **Settings** holds every rule, owners, the team numbers and the chat spaces.

The desk never answers anyone by itself.

- How every step of the flow document is implemented: [docs/RULES.md](docs/RULES.md)
- Putting it on a server: [docs/DEPLOY.md](docs/DEPLOY.md)
- Adding features: [docs/EXTENDING.md](docs/EXTENDING.md)

## On a server (recommended)

```bash
git clone https://github.com/amanrankkking-eng/whatsapp-desk.git
cd whatsapp-desk
sudo ./scripts/setup.sh
```

Then open `https://<your domain>`. Go to **Numbers → Add WhatsApp** and scan each phone. Details are in [docs/DEPLOY.md](docs/DEPLOY.md).

## On the Mac (next to the existing local Evolution)

`~/Claude/evolution-local` already runs a patched Evolution API and Postgres. The desk reads that install's database password and API key by itself:

```bash
~/Claude/evolution-local/evo start
./scripts/mac/desk start
```

This opens on http://localhost:8092. It replaces the older dashboard in `evolution-local/dashboard`; stop that one first, because they use the same port.

## Layout

```
desk/        the dashboard (Node 22 + Postgres, no framework, no build step)
  src/       server, flow logic, plugins/
  public/    the web app
  test/      end-to-end test, mock Evolution API, demo
evolution/   Dockerfile for Evolution API 2.3.7 plus the three patches the desk relies on
scripts/     setup.sh (server), backup.sh, mac/desk (local runner)
docs/        RULES, DEPLOY, EXTENDING
```

## Security

- The dashboard needs a login whenever `DESK_PASSWORD` is set, which is always the case on a server. Sessions last 14 days, and wrong passwords are rate-limited.
- Only the configured host names are answered, which guards against DNS rebinding. Every change must come from the page itself: same origin and a custom header.
- Evolution API and Postgres are never exposed to the internet. Caddy serves HTTPS with an automatic certificate.
- Media from WhatsApp is served with `nosniff` and a sandbox policy, and unsafe types are always downloaded rather than shown.
