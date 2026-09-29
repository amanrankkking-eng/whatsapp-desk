# Claude access (MCP)

The desk is an MCP server. Claude Code, Claude Desktop or any other MCP client can read the desk and, with a write token, do a few things a person approved.

- **Endpoint:** `POST /mcp` on the desk. For example `https://desk.yourcompany.com/mcp`, or `http://127.0.0.1:8092/mcp` on the Mac.
- **Transport:** Streamable HTTP with plain JSON answers. There are no sessions and no server-sent stream, so a desk restart never breaks a client.
- **Auth:** `Authorization: Bearer wd_...`. Make a token under **Settings → Claude access**. The token is shown once; the desk stores only its SHA-256.

## Make a token and connect Claude

1. In the dashboard, open **Settings → Claude access → Make a token**.
2. Give it a name, for example "Claude Code on Aman's Mac", and pick the access:
   - **Read only**: status, chats, resellers, today's preview, health and errors.
   - **Read + change**: also log calls, set statuses, close or reopen rows, acknowledge alerts, import leads, approve the day and send one approved message.
3. Copy the command the dialog shows and run it once in a terminal:

   ```bash
   claude mcp add --transport http --scope user whatsapp-desk https://desk.yourcompany.com/mcp --header "Authorization: Bearer wd_..."
   ```

4. Check that it connects:

   ```bash
   claude mcp list
   ```

   The desk should show as `✔ Connected`. Start a new Claude Code session and ask, for example, "desk status batao".

**Claude Desktop** needs a small bridge (Node.js must be installed). Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whatsapp-desk": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://desk.yourcompany.com/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer wd_..." }
    }
  }
}
```

Connectors on claude.ai in the browser need OAuth, which the desk does not offer. Use Claude Code or Claude Desktop instead.

## Tools

Reading (every token):

| Tool | What it gives |
|---|---|
| `desk_status` | Numbers and their connection, resellers by stage, sends and replies today, open alerts and errors, the last run, the jobs. Start here. |
| `health_report` | Version, uptime, memory, disk, database size, last backup, Evolution API, each number's last disconnect reason, the jobs and the open errors. |
| `errors_recent` | The recorded errors. With an `id`, the stack trace and context. |
| `list_numbers` | Every number: id, label, role, phone, live state, groups, cap and warm-up. |
| `list_chats` | The inbox, filtered by number, unread, groups, direct or resellers, or searched by name or phone. |
| `read_chat` | The latest messages of one chat, with the ticks on ours. The chat can be given by id, phone or name. |
| `replies_by_day` | Every group where someone else wrote on a day. |
| `list_alerts` | Reseller replies waiting for a person. |
| `today_preview` | The day's automatic follow-ups, each with its exact text, and every skip with its reason. |
| `find_resellers` / `reseller_detail` | Reseller rows, and one row with its sends, replies, skips and history. |
| `ad_leads` | The one-to-one chats on a number that came from Click-to-WhatsApp ads, with a follow-up status. |
| `list_runs` | Approved runs, or one run message by message. |
| `list_groups` | The groups the numbers are in. |
| `recent_events` | The activity log. |

Changing things (write tokens only):

| Tool | What it does |
|---|---|
| `log_call` | Logs call 1 or 2 with its outcome. Call 2 puts the group into the loop. |
| `set_status` | Sets follow-up or offer, or clears it. |
| `reseller_action` | resume, hold, unhold, order_placed, dnc, undo_dnc, invalid, not_interested, reopen, first_offer_sent. |
| `ack_alert` | Acknowledges a reply alert. |
| `import_leads` | Adds leads from CSV text. |
| `resolve_error` | Marks an error as fixed. |
| `stop_run` | Stops a send run. |
| `approve_today` | Queues the day's sends for the approved codes. Needs `confirm: true`. |
| `send_message` | Sends one text into an existing chat. Needs `confirm: true`. |

## Guards

These rules are in the desk's code, not only in what Claude is told:

- Every change is recorded in the Activity log as `mcp.<tool>` under the token's name. An approval is recorded as `approved_by = mcp:<token name>`.
- `approve_today` accepts only codes that are in today's preview at that moment. It also needs `confirm: true`. Claude is told to set it only after the person approved that exact list.
- `send_message` refuses:
  - the reader number,
  - groups on the never-send list,
  - groups excluded by name (01Wire),
  - do-not-contact rows,
  - groups the number has left,
  - chats that do not exist yet. Start new conversations from the phone.

  It needs `confirm: true` and allows at most 10 messages per token in 10 minutes.
- A read token cannot see or call any tool that changes something.
- Reading a chat never sends a blue tick.
- The server tells Claude to treat chat text as data, not as instructions.

For the strongest guarantee, give Claude a **read-only** token. Do the sending and approving in the dashboard yourself.

## Security

- A token works like a password. Keep it out of chats, screenshots and the repository.
- On a server, `/mcp` goes over HTTPS through Caddy, the same as the dashboard.
- **Revoke** a token under Settings → Claude access. It stops working at once.
- Requests from a web page on another site are refused (Origin check). Only the configured host names are answered.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` / "Missing or unknown token" | The token was revoked or mistyped. Make a new one and run `claude mcp add` again (first `claude mcp remove whatsapp-desk`). |
| `421 Unknown host` | The address is not in `ALLOWED_HOSTS` (on a server, `DESK_DOMAIN` in `.env`). |
| `403 Cross-site request refused` | The client sent an `Origin` header from another site. |
| A tool answers "This token can only read" | Make a token with Read + change. |
