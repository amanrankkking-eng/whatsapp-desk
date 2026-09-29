// Database access and the dashboard's own schema ("desk"). Evolution keeps its tables in
// the "evolution_api" schema of the same database; the desk only reads those.
import pg from 'pg';
import { cfg } from './config.mjs';

// Dates stay plain "YYYY-MM-DD" strings so the server's own time zone can never shift a day.
pg.types.setTypeParser(1082, v => v);
export const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 8 });
pool.on('error', err => console.error('[db]', err.message));
export const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
export const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn((sql, params = []) => c.query(sql, params).then(r => r.rows));
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

const SKIP_TYPES = `'protocolMessage','reactionMessage','senderKeyDistributionMessage','associatedChildMessage',
  'messageContextInfo','pollUpdateMessage','editedMessage'`;

export async function migrate() {
  await q(`create schema if not exists desk`);
  await q(`create table if not exists desk.meta (key text primary key, value jsonb not null)`);

  // ---- WhatsApp numbers (one Evolution instance each)
  await q(`create table if not exists desk.numbers (
    instance text primary key, label text not null, role text not null default 'sender',
    phone text, lid text, profile_name text, state text, state_at timestamptz,
    daily_cap int not null default 10, active boolean not null default true,
    warmup_started date, notes text not null default '', sort int not null default 0,
    created_at timestamptz not null default now())`);

  // ---- groups and members, per number
  await q(`create table if not exists desk.groups (
    instance text not null, jid text not null, subject text, size int, announce boolean default false,
    is_community boolean default false, is_community_announce boolean default false,
    left_group boolean not null default false, synced_at timestamptz, primary key (instance, jid))`);
  // A group a number was already in at its first sync existed before the desk. It is not a new
  // reseller group, so it is never reported as "no match" (step 37 is about new groups).
  await q(`alter table desk.groups add column if not exists preexisting boolean not null default false`);
  await q(`alter table desk.groups add column if not exists first_seen timestamptz default now()`);
  await q(`create table if not exists desk.group_members (
    instance text not null, jid text not null, member_id text not null, phone text, admin text,
    primary key (instance, jid, member_id))`);
  await q(`create index if not exists group_members_member on desk.group_members(member_id)`);
  await q(`create index if not exists group_members_phone on desk.group_members(phone)`);
  // WhatsApp's private ids (lid) mapped to phone numbers, learned from members and messages.
  await q(`create table if not exists desk.lid_map (lid text primary key, phone text not null, seen_at timestamptz default now())`);
  await q(`create table if not exists desk.people (
    member_id text primary key, phone text, name text, group_count int not null default 0,
    is_team boolean not null default false, is_ours boolean not null default false)`);
  await q(`create index if not exists people_phone on desk.people(phone)`);

  // ---- owners and resellers
  await q(`create table if not exists desk.owners (
    id serial primary key, name text not null unique, phone text, chat_webhook text,
    active boolean not null default true, created_at timestamptz not null default now())`);
  await q(`create table if not exists desk.resellers (
    id serial primary key, code text unique, name text not null default '', phone text unique,
    phone_raw text, company text not null default '', city text not null default '', email text not null default '',
    source text not null default '', owner_id int references desk.owners(id) on delete set null,
    stage text not null default 'new',
    call1_outcome text, call1_note text, call1_at timestamptz,
    call2_outcome text, call2_note text, call2_at timestamptz,
    first_offer_at timestamptz,
    instance text, group_jid text, bound_at timestamptz, bound_by text,
    track text, track_source text, track_reason text, track_at timestamptz,
    fu_batch int, of_batch int,
    last_msg_at timestamptz, last_msg_by text, last_msg_text text, last_ours_at timestamptz, last_client_at timestamptz,
    readable boolean, replied boolean not null default false, last_reply_at timestamptz, last_reply_text text,
    paused boolean not null default false, pause_reason text,
    hold boolean not null default false, dnc boolean not null default false,
    left_group boolean not null default false, intro_pending boolean not null default false,
    next_due date, notes text not null default '',
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await q(`create unique index if not exists resellers_group on desk.resellers(group_jid) where group_jid is not null`);
  await q(`create table if not exists desk.lead_rejects (
    id bigserial primary key, raw jsonb not null, reason text not null, created_at timestamptz not null default now())`);
  await q(`create table if not exists desk.bind_issues (
    jid text primary key, reason text not null, detail jsonb, ignored boolean not null default false,
    seen_at timestamptz not null default now())`);

  // ---- rate card, headings, message ladders
  await q(`create table if not exists desk.rate_packages (
    id serial primary key, label text not null, price text not null default '', tat text not null default '',
    reach text not null default '', sample_url text not null default '', active boolean not null default true,
    sort int not null default 0)`);
  await q(`create table if not exists desk.rate_outlets (
    id serial primary key, package_id int not null references desk.rate_packages(id) on delete cascade,
    name text not null, available boolean not null default true, sort int not null default 0)`);
  await q(`create table if not exists desk.headings (id serial primary key, template text not null, sort int not null default 0)`);
  await q(`create table if not exists desk.rungs (
    id serial primary key, ring text not null, position int not null, label text not null unique, template text not null,
    package_id int references desk.rate_packages(id) on delete set null, active boolean not null default true,
    created_at timestamptz not null default now())`);

  // ---- rings, runs, sends, replies, alerts, reports
  await q(`create table if not exists desk.ring_state (ring text primary key, last_batch int not null default 0, last_run_date date)`);
  await q(`insert into desk.ring_state (ring) values ('follow_up'), ('offer') on conflict do nothing`);
  await q(`create table if not exists desk.runs (
    id serial primary key, day date not null, status text not null default 'approved',
    fu_batch int, of_batch int, ring_len int, plan jsonb not null, approved_by text,
    created_at timestamptz not null default now(), finished_at timestamptz, stop_reason text)`);
  await q(`create table if not exists desk.sends (
    id bigserial primary key, run_id int references desk.runs(id), reseller_id int references desk.resellers(id),
    instance text not null, jid text not null, ring text not null, rung_id int, rung_label text, package_label text,
    heading_id int, text text not null, tagged text, tagged_name text, scheduled_at timestamptz not null,
    status text not null default 'queued', sent_at timestamptz, wa_msg_id text, response jsonb, error text,
    created_at timestamptz not null default now())`);
  await q(`create index if not exists sends_due on desk.sends(status, scheduled_at)`);
  await q(`create unique index if not exists sends_once on desk.sends(reseller_id, rung_label) where status in ('queued','sending','sent')`);
  // Append-only: one row per message that actually went out. Reports read this.
  await q(`create table if not exists desk.send_log (
    id bigserial primary key, send_id bigint, run_id int, reseller_id int, instance text, jid text, ring text,
    rung_label text, package_label text, text text, tagged text, sent_at timestamptz not null, wa_msg_id text, response jsonb)`);
  await q(`create table if not exists desk.skips (
    id bigserial primary key, day date not null, run_id int, reseller_id int, jid text, ring text, reason text not null,
    created_at timestamptz not null default now())`);
  // Append-only: one row per message a reseller wrote in their group.
  await q(`create table if not exists desk.replies (
    id bigserial primary key, msg_id text not null, instance text not null, jid text not null, reseller_id int,
    ts timestamptz not null, sender text, sender_name text, text text, signal text, stop_word boolean not null default false,
    created_at timestamptz not null default now(), unique (instance, jid, msg_id))`);
  await q(`create table if not exists desk.alerts (
    id bigserial primary key, reseller_id int references desk.resellers(id), owner_id int, instance text, jid text,
    kind text not null default 'reply', count int not null default 1, text text, first_at timestamptz not null default now(),
    last_at timestamptz not null default now(), last_notified_at timestamptz, notify_count int not null default 0,
    acked_at timestamptz, acked_by text)`);
  await q(`create table if not exists desk.reports (
    id serial primary key, day date not null, kind text not null, owner_id int, title text, body text not null,
    posted_at timestamptz, post_error text, created_at timestamptz not null default now())`);
  await q(`create table if not exists desk.events (
    id bigserial primary key, ts timestamptz not null default now(), kind text not null, who text, detail jsonb)`);
  await q(`create table if not exists desk.sessions (token text primary key, username text not null, expires_at timestamptz not null)`);
  // What a person has already seen in the inbox. Kept here only, so WhatsApp never gets a blue tick from us.
  await q(`create table if not exists desk.chat_seen (instance text not null, jid text not null, ts bigint not null, primary key (instance, jid))`);
  await q(`insert into desk.meta (key, value) values ('installed_at', to_jsonb(extract(epoch from now())::bigint)) on conflict do nothing`);

  // ---- views over Evolution's messages
  // Speeds up the per-chat reads below; lives in Evolution's schema but changes nothing there.
  await q(`create index if not exists desk_msg_jid_idx on evolution_api."Message" ((key->>'remoteJid'), "instanceId")`);
  // One row per message and direction: on an ad chat, the lead's first message and WhatsApp's
  // ad card carry the same id, so the direction is part of the key.
  await q(`create or replace view desk.msg as
    select distinct on (m."instanceId", m.key->>'remoteJid', m.key->>'id', coalesce((m.key->>'fromMe')::boolean, false))
      i.name as instance, m.id as row_id, m.key->>'id' as id, m.key->>'remoteJid' as jid,
      coalesce((m.key->>'fromMe')::boolean, false) as from_me,
      nullif(coalesce(nullif(m.key->>'participant', ''), m.participant), '') as sender,
      nullif(m.key->>'participantAlt', '') as sender_alt,
      m."pushName" as push_name, m."messageType" as type, m.message, m."contextInfo" as context,
      m."messageTimestamp" as ts, m.status
    from evolution_api."Message" m join evolution_api."Instance" i on i.id = m."instanceId"
    where m."messageType" not in (${SKIP_TYPES})
      and m.key->>'remoteJid' not like '%@broadcast' and m.key->>'remoteJid' not like '%@newsletter'
    order by m."instanceId", m.key->>'remoteJid', m.key->>'id', coalesce((m.key->>'fromMe')::boolean, false), m."messageTimestamp"`);
  // Who sent it (a lid or a phone jid) and whether that sender is on our side.
  await q(`create table if not exists desk.our_phones (phone text primary key, why text not null)`);
  await q(`create or replace view desk.msgx as
    select s.*, coalesce(p.name, case when s.push_name !~ '^[0-9]+$' then s.push_name end) as sender_name,
      (s.from_me or coalesce(p.is_ours, false) or op.phone is not null) as ours
    from (
      select m.*,
        coalesce(m.sender, case when m.push_name ~ '^[0-9]+$' then m.push_name || '@lid' end) as sender_id,
        coalesce(nullif(split_part(m.sender_alt, '@', 1), ''),
                 case when m.sender like '%@s.whatsapp.net' then split_part(split_part(m.sender, '@', 1), ':', 1) end,
                 lm.phone) as sender_phone
      from desk.msg m
        left join desk.lid_map lm on lm.lid = coalesce(m.sender, case when m.push_name ~ '^[0-9]+$' then m.push_name || '@lid' end)
    ) s
      left join desk.people p on p.member_id = s.sender_id
      left join desk.our_phones op on op.phone = s.sender_phone`);
  // ---- monitoring: every server-side error, grouped; system alerts sent; tokens for Claude (MCP)
  await q(`create table if not exists desk.errors (
    id bigserial primary key, fingerprint text not null, source text not null, where_ text, message text not null,
    stack text, context jsonb, version text, count int not null default 1,
    first_at timestamptz not null default now(), last_at timestamptz not null default now(),
    notified_at timestamptz, resolved_at timestamptz, resolved_by text)`);
  await q(`create unique index if not exists errors_open_fp on desk.errors(fingerprint) where resolved_at is null`);
  await q(`create table if not exists desk.ops_alerts (key text primary key, last_sent_at timestamptz not null, sent int not null default 1, last_text text)`);
  await q(`create table if not exists desk.api_tokens (
    id serial primary key, name text not null, token_hash text not null unique, created_at timestamptz not null default now(),
    last_used_at timestamptz, revoked_at timestamptz)`);
  // read = look only; write = may also change rows, approve the day and send one message
  await q(`alter table desk.api_tokens add column if not exists scope text not null default 'read'`);
  await q(`insert into desk.meta (key, value) values ('schema_version', '2') on conflict (key) do update set value = excluded.value`);
}

export async function logEvent(kind, detail = {}, who = null) {
  await q(`insert into desk.events (kind, who, detail) values ($1, $2, $3)`, [kind, who, JSON.stringify(detail)]).catch(() => {});
}
