# How WhatsApp Desk follows "Reseller Automation — Every Step, Start to End"

Every numbered step of the flow document (22 Sep 2026), and what the desk does about it.

- **Automatic** — the desk does it by itself.
- **Enforced** — the desk refuses to do otherwise.
- **Person** — a person does it; the desk records it, shows it, or checks it.

Every automatic step below is covered by the end-to-end test in `desk/test/e2e.test.mjs`. That test walks a fake
calendar from Stage 0 to Stage 12 against a mock Evolution API.

## Stage 0 — One-time setup

| # | Step | How the desk does it |
|---|---|---|
| 1 | One account holds several numbers | One Evolution server holds every number, and one dashboard shows them all. **Numbers → Add WhatsApp** adds another. |
| 2 | One reader that never sends | Give a number the role **Reader**. **Enforced**: the desk never sends from it, neither in automatic runs nor from the inbox. Putting the reader into every group is a **person**'s job. |
| 3 | Three to five senders | Any number of **Sender** numbers. |
| 4 | Each number scanned once | **Add WhatsApp** shows a QR, or an 8-character code for linking by phone number. |
| 5 | About three weeks of warm-up | **Enforced**: a number added from the dashboard carries no automatic message for 21 days (a setting). A person can end the warm-up early on the Numbers page. |
| 6 | Each sender joins only its slice, a few at a time | **Person**. The Numbers page shows how many reseller groups each sender owns. |
| 7 | Ramp 25 → 50 → full | Each sender has its own daily cap for automatic messages. Raising it is a **person**'s decision. |
| 8 | Groups split into slices | **Automatic**: a group belongs to the one sender number that sits in it. |
| 9 | Batches of 20 | **Automatic**. The batch size is a setting (20). |
| 10 | A follow-up ring and an offer ring | **Automatic**. Each ring keeps its own counter. |
| 11 | One batch of each ring, half a ring apart | **Automatic** when a group is bound. |
| 12 | Never-send list by name | Settings → *Never-send list*. It starts with test, testing, test group and shersth bharath. **Enforced**: these groups are never bound and never messaged. *Keep out any group whose name contains* starts with `01wire`, so Ahmad sir's 01Wire groups never enter Roshan's loop. |
| 13 | Every group has one named owner | The owner is set on each reseller row. Alerts and the daily brief go to that owner by name. |
| 14 | The reseller sheet | The **Resellers** page is the sheet: one row per reseller, with every column the flow reads and writes. **Export CSV** gives a copy at any time. |
| 15 | The rate card | **Messages & rate card → Rate card**: packages, prices, named outlets (each can be switched off), reach, turnaround and sample link. Messages are built from it, never typed. |
| 16 | Five heading styles | **Messages & rate card → Heading styles**. They rotate. |
| 17 | Chat space and owner alert routes | Settings → *Team chat space webhook*, plus an optional webhook per owner. Both have a *Send a test message* button. **Waiting for your chat space.** |

## Stage 1 — A lead becomes a group

| # | Step | How |
|---|---|---|
| 18 | Leads handed over | **Person**. |
| 19 | Leads pulled in, one row each | **Resellers → Import leads**: paste from the sheet or pick a CSV. |
| 20 | Phones normalised; malformed rejected | **Automatic**. Indian 10-digit numbers get 91. Bad numbers are rejected with the reason. |
| 21 | Duplicates dropped with the reason | **Automatic**. Rejects are kept on the *Needs a person* page. Nothing is deleted. |
| 22–23 | Call 1, logged in two taps | Open the reseller, then tap the outcome (Call 1 or Call 2 is preselected). A note is optional. |
| 24–26 | Group created, named with the id, reader and sender added | **Person**. |
| 27 | First offer sent by hand, once | **Person**, from the phone or from the dashboard inbox. The desk records its date as the first offer. |
| 28 | That message makes the group readable | A group with nothing to read shows under *Groups that cannot be read*. It is never treated as quiet. |
| 29–30 | Call 2, logged the same way | Same two taps. |
| 31 | Call 2 is the switch | **Enforced**: until call 2 is logged, the group is skipped with "call 2 is not logged yet". |

## Stage 2 — The group is bound to its row

| # | Step | How |
|---|---|---|
| 32 | A new group is seen within 10 minutes | **Automatic**. The read runs every 3 minutes. It finds new groups from each number's chat list, and does a full group sync every 10 minutes. |
| 33–35 | Read the members, remove our side, match the rest by phone | **Automatic**. "Our side" means every connected number, the team numbers, the other company numbers, and anyone in two or more of our groups. |
| 36 | Exactly one match binds | **Automatic**. The group must also hold exactly one sender number, and that sender becomes the group's own number. |
| 37 | Anything else is reported | **Automatic**. No match, several matches, a reseller who already has a group, or two senders in one group all go to *Needs a person*, with **Bind to a reseller…** and **Ignore** buttons. |
| 38 | The name is only a sanity check | **Enforced**: the group name is never used to match. A name that does not mention the code is noted in the log. |
| 39–40 | Joins the sender's slice; one batch of each ring, half a ring apart | **Automatic**. |

## Stage 3 — The read

| # | Step | How |
|---|---|---|
| 41 | Every group read every day | **Automatic**: every bound group is read every 3 minutes, at no cost. |
| 42–43 | Last message, who, when; row updated | **Automatic**: last message, by whom, when, days since, and replied yes or no. |
| 44 | Unreadable groups flagged, never guessed | **Automatic**: they are listed for a person and skipped by the *readable* check. |

## Stage 4 — Which ring, which batch

| # | Step | How |
|---|---|---|
| 45 | A status set by hand wins | **Enforced**: the chat is not read for that row. |
| 46–48 | Otherwise the chat decides | **Automatic**. No reply, or a reply with no buying words, goes to the follow-up ring. Asking the price, rate, catalogue or packages, or talking about an order, goes to the offer ring. *This is a word list, not an AI model.* A person overrules it with one tap. |
| 49 | Marked as read from the chat or set by a person | Shown on every row and in the preview. |
| 50 | No status when the chat cannot be read | **Automatic**: listed under *Needs a status* on the Today page, *Needs a person*, and the chat summary. |
| 51–53 | A counter per ring; today = counter + 1; wraps to 1 | **Automatic**. |
| 54 | The counter moves only on a day a batch ran | **Enforced**. A stopped run or a day off never moves it. A send day with nothing due closes by itself after 17:30 as a rest day. A day with messages waiting for approval never moves without that approval. |
| 55 | Both counters move together | **Automatic**. |
| 56 | Longest-waiting group first | **Automatic**. |
| 57 | Nobody gets two messages in one day | **Enforced**: a group is in one ring at a time (its status), so it can be due only once per day. |

## Stage 5 — The six checks (at the moment of sending, read live)

Every check runs at preview time. It runs again, live, right before each individual message goes out.

| # | Check | Default |
|---|---|---|
| 58 | Gap: days since we last wrote | 10 |
| 59 | Repeat: this exact message never went to this group | By message label. It is also a unique rule in the database. |
| 60 | Live conversation | Reseller wrote within 7 days, or we wrote within 3 days. The document says only "recently", so these defaults are editable. |
| 61 | Unanswered question | Reseller had the last word within 21 days. |
| 62 | Someone to sell to | Reseller is still a member. |
| 63 | Readable | Something can be read in the group. |
| 64–66 | One failure skips the group for today. It is never dropped, and every skip reason is written down. | **Automatic**. |
| 67 | Never-send and hold never reach the checks | **Enforced**. The same goes for do-not-contact. |

## Stage 6 — Building the message

| # | Step | How |
|---|---|---|
| 68 | The next message in the group's own ladder | **Automatic**. The follow-up ladder is F1–F5; the offer ladder is O1–O3, and new ones can be added. |
| 69–70 | Built from the rate card; unavailable outlets dropped | **Automatic**. |
| 71 | A heading style is picked from the five | **Automatic**. It rotates across groups and rounds. |
| 72 | Package number never in the text | **Enforced**. It is kept only as a label on the send record. |
| 73 | The reseller is @-mentioned | **Automatic**: it is a real WhatsApp mention. |
| 74–77 | Tag rules | **Enforced**. Only a number in exactly one of our groups can be tagged. Team numbers are never tagged. Anyone tagged in the last 7 days is passed over for the next contact. With no safe contact, the message goes untagged. |
| — | Unfinished copy | **Enforced**: a message with any `[bracketed]` text is held and never sent. |

## Stage 7 — Approval and sending

| # | Step | How |
|---|---|---|
| 78 | The whole day as a preview | **Today's sends**: every name, group, sender, time, exact text, why that message, the tag, and every skip with its reason. |
| 79 | Nothing sends until approved | **Enforced**. The approve dialog lists the named groups. The only automatic action is closing a day that has nothing to send, and that sends nothing. |
| 80 | Each group from its own sender | **Enforced**. |
| 81–82 | One at a time, a random 5–14 minute gap, never on a round minute | **Automatic**, for each number. Each sender sends one message at a time. Different senders run side by side. |
| 83 | 10:30–17:30, Monday to Friday | **Enforced** at approval and before every message. If the window closes, the run stops. |
| 84 | About 10 per sender, 40 in total | **Enforced**: each sender has a daily cap, and there is a total cap. Both are editable. |
| 85 | The first API error stops the run | **Enforced**. The rest waits for the next day, and the counters do not move. |

## Stage 8 — What gets recorded

| # | Step | How |
|---|---|---|
| 86 | Every send recorded the moment it succeeds | Time, group, message, sender number, who was tagged, and Evolution's answer. |
| 87 | The row is updated | What went, when, and the next due date. |
| 88 | Re-running the day sends nothing twice | **Enforced**. Covered by a test. |
| 89–90 | Two append-only records | Every send and every reply. The reports and exports are worked out from them. |

## Stage 9 — What the team is told

| # | Step | How |
|---|---|---|
| 91–97 | One message into the chat space after each run | Messages sent (and to which groups), skipped (by check), waiting (and for how long), needing a status, due tomorrow, and unanswered replies. |
| 98 | Each owner gets their own brief | Their groups in the loop, what went, what was skipped, and their pending replies. It goes to their webhook if one is set; every report is also kept on the **Reports** page. |

## Stage 10 — The next day

Steps 99–105 are **automatic**: the counters move, yesterday's groups go back into the pool, and skipped groups wait for their next turn. The ring is padded to at least 16 batches. With a small pool, a ring therefore never turns faster than the 10-day gap.

## Stage 11 — When a reseller replies

| # | Step | How |
|---|---|---|
| 106 | The reply is seen within 10 minutes | **Automatic**: within 3 minutes. |
| 107 | Only the reseller's side counts | **Enforced**. Messages from our numbers, the team or our other numbers never count as a reply. |
| 108–109 | The ladder pauses at once; the reply is written onto the row | **Automatic**. |
| 110–111 | The owner is alerted by name, with the reseller, the group and the exact words | **Automatic**, on the Replies & alerts page and in Google Chat. |
| 112–113 | The alert repeats until acknowledged; who and when is recorded | **Automatic**. It repeats every 30 minutes, 09:00–21:00 (both editable). |
| 114 | Five messages in a row are one alert | **Automatic**. |
| 115 | Nothing fires after our own message | **Enforced**. |
| 116 | Claude never answers anyone | **Enforced**. The desk has no auto-reply of any kind. |
| 117 | A person marks the row | The **Conversation over — back in the loop** button. |

## Stage 12 — Leaving the loop

| # | Step | How |
|---|---|---|
| 118 | Order placed | Button. The row becomes an active reseller and leaves the rings. |
| 119 | Asked to stop | **Automatic** on stop words (stop, band karo, mat bhejo…). Also a button. Do-not-contact is checked before everything else. |
| 120 | Every message used | **Automatic**: marked exhausted and reported that way, never as converted. |
| 121 | Reseller left the group | **Automatic**: the row is paused and the owner alerted. **Enforced**: the group is never re-bound to anyone else in it. |
| 122 | Wrong number / not on WhatsApp | A call outcome or a button. The row is marked invalid and leaves the pool. |
| 123 | An exhausted group comes back | **Automatic** when a new message is added to its ladder. A person can also bring it back with **Put back in the loop**. |
| 124 | Everything else stays in the loop | **Automatic**. |
| 125–127 | A sender is lost | **Automatic**: only that sender's slice is skipped, and the others keep sending. **Numbers → Move slice** hands its groups to another sender. That sender must first be added to those groups. Its first message opens with "Hi, this is … writing to you from this number from now on." |
| 128 | Nothing is lost | Every record is in our own database. `scripts/backup.sh` copies it. |

## Choices made where the document leaves room (please confirm)

1. **Reading the status.** The chat is read with a list of buying words, not an AI model. A person overrules it with one tap on the row.
2. **The sheets.** The reseller sheet and the rate card live inside the desk, with CSV export. Syncing them to Google Sheets can be added later as a plugin.
3. **"Recently"** in the live-conversation check means 7 days for the reseller and 3 days for us.
4. **One at a time** is per number. Each sender waits 5–14 minutes between its own messages, and senders work side by side. Forty messages across four senders take about 1.5 hours instead of about 6.
5. **Rest days.** A send day with nothing due closes by itself after the window, so the rings keep turning over holidays in the pool. A day with messages waiting for approval never closes without that approval.
