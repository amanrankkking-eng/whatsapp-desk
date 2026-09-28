# Putting WhatsApp Desk on a server

This runs four containers: Postgres, Evolution API (patched), the desk, and Caddy for HTTPS.
Only Caddy is reachable from the internet. Evolution and the database sit on the internal Docker network.

## What you need

- A Linux server (Ubuntu 22.04 or 24.04) with 2 vCPU, 4 GB RAM and 40 GB disk. Any provider works.
  WhatsApp sessions live on this server, so it must run all the time.
- A domain or subdomain, for example `desk.yourcompany.com`, with an **A record** pointing at the server's IP.
- Ports 22, 80 and 443 open.

## 1. Get the code onto the server

The repository is private, so the server needs a way to read it. Use one of these:

- **Personal access token.** On GitHub go to Settings → Developer settings → Fine-grained tokens, and give the token read access to this repository. Then clone with the token in the URL:

  ```bash
  git clone https://<TOKEN>@github.com/amanrankkking-eng/whatsapp-desk.git
  ```

- **Deploy key.** Run `ssh-keygen -t ed25519` on the server. Add the `.pub` file under the repository's Settings → Deploy keys, then clone over SSH:

  ```bash
  git clone git@github.com:amanrankkking-eng/whatsapp-desk.git
  ```

## 2. Set up and start

```bash
cd whatsapp-desk
sudo ./scripts/setup.sh
```

The script:

1. Installs Docker if it is missing.
2. Asks for the domain, a username and a password.
3. Generates the database password and the Evolution key into `.env`.
4. Builds the images and starts everything.

The first build takes 5–10 minutes. Evolution is compiled from source with the three patches in `evolution/patches`.

Check that it is up:

```bash
docker compose ps
docker compose logs -f desk
```

Then open `https://desk.yourcompany.com` and sign in.

## 3. Connect the WhatsApp numbers

Go to **Numbers → Add WhatsApp**. Give the number a name and a role (one **Reader**, the rest **Senders**), then press **Create and show QR**.
On that phone, open WhatsApp → Settings → Linked devices → Link a device, and scan.
If scanning is awkward, open *Link with the phone number instead*. You get an 8-character code to type on the phone.

Do not link the Periskope numbers or the Cloud Station number here.

## 4. Fill in the settings

- **Settings → Google Chat.** Paste the team space webhook. In Google Chat, open the space → Apps & integrations → Webhooks → Add webhook, then copy the URL. Press *Send a test message*.
- **Settings → Owners.** Add each owner. A personal webhook is optional; without one, their alerts go to the team space.
- **Settings → Our side.**
  - *Team numbers*: they are never tagged.
  - *Other company numbers*: for example the Periskope numbers, so their messages count as ours.
- **Resellers → Import leads.**

From then on, every send day: **Today's sends**, check the list, then **Approve and send**.

## Updating

```bash
cd whatsapp-desk
git pull
docker compose up -d --build
```

The database schema updates itself when the desk starts. A restart never resends anything. A message that was in flight is marked failed and its run stops, so a person can check the group before it goes again.

## Backups

```bash
./scripts/backup.sh
```

This writes the database dump and the WhatsApp session files into `backups/` and keeps 30 days.
For a daily backup at 02:15, add this with `crontab -e`:

```
15 2 * * * cd /root/whatsapp-desk && ./scripts/backup.sh >/dev/null 2>&1
```

Copy `backups/` off the server now and then, for example to Google Drive with rclone.

## Without a domain (not recommended)

Set `DESK_DOMAIN=http://<server-ip>` and `COOKIE_SECURE=0` in `.env`, then run `docker compose up -d`.
The password then travels without encryption, so use this only for a short test.

## Moving from the Mac

The Mac install (`~/Claude/evolution-local`) and a server are separate WhatsApp logins. On the server, link each number again with **Add WhatsApp**. With *Bring in the chats this phone already has* ticked, WhatsApp sends the phone's recent history, so groups become readable again.
Reseller rows, owners and settings can be carried over with **Export CSV** on the Mac, then **Import leads** on the server.
For a full copy of the Mac data, restore a `pg_dump` of the `desk` schema.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| The page does not load | `docker compose ps`; `docker compose logs caddy` (a certificate problem usually means the A record is not pointing here yet). |
| "Unknown host" (421) | `DESK_DOMAIN` in `.env` must match the address in the browser exactly. |
| A number shows "Evolution not answering" | `docker compose logs evolution`. |
| "Couldn't link device" on the phone | Scan the next QR. The first one can fail while WhatsApp rotates a secret; the Baileys patch handles the rest. |
| Background jobs | The Overview page shows each job's last run and last error. |
