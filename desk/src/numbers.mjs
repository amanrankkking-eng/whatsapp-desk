// WhatsApp numbers: add (QR or pairing code), status, roles, groups and members.
import { q, one, tx, logEvent } from './db.mjs';
import { evo, connectionState, fetchInstances, encodeInstance } from './evo.mjs';
import { getSettings } from './settings.mjs';
import { httpError, digitsOf, squash, normalizePhone, istDate, now } from './util.mjs';

const ROLES = ['sender', 'reader'];

// Every Evolution instance is a number. Instances created outside the dashboard are adopted.
export async function syncNumbers() {
  let list = [];
  try { list = await fetchInstances(); } catch (e) { return { error: e.message }; }
  for (const x of list) {
    const name = x.name || x.instanceName;
    if (!name) continue;
    const phone = digitsOf(x.ownerJid || x.owner || '') || null;
    await q(`insert into desk.numbers (instance, label, phone, profile_name, state, state_at, sort)
      values ($1, $2, $3, $4, $5, now(), (select coalesce(max(sort), 0) + 1 from desk.numbers))
      on conflict (instance) do update set phone = coalesce(excluded.phone, desk.numbers.phone),
        profile_name = coalesce(excluded.profile_name, desk.numbers.profile_name), state = excluded.state, state_at = now()`,
      [name, x.profileName || name, phone && phone.length >= 8 ? phone : null, x.profileName || null, x.connectionStatus || x.status || null]);
  }
  const names = list.map(x => x.name || x.instanceName).filter(Boolean);
  await q(`update desk.numbers set state = 'missing', state_at = now() where not (instance = any($1))`, [names]);
  return { count: names.length };
}

export async function listNumbers() {
  const rows = await q(`select n.*,
      (select count(*)::int from desk.groups g where g.instance = n.instance and not g.left_group) groups,
      (select count(*)::int from desk.resellers r where r.instance = n.instance and r.group_jid is not null) slice
    from desk.numbers n order by n.sort, n.created_at`);
  return rows;
}

export async function addNumber({ label, role, phone, history }) {
  label = String(label || '').trim().slice(0, 60);
  if (!label) throw httpError(400, 'Give the number a name, for example "Sender 2" or "Reader"');
  if (!ROLES.includes(role)) role = 'sender';
  let number = null;
  if (phone) {
    const p = normalizePhone(phone);
    if (!p.ok) throw httpError(400, `Phone number: ${p.reason}`);
    number = p.phone;
  }
  const base = squash(label).slice(0, 20) || 'number';
  let instance = `wa-${base}`;
  for (let i = 2; await one(`select 1 from desk.numbers where instance = $1`, [instance]); i++) instance = `wa-${base}-${i}`;
  const d = await createInstance(instance, number, history !== false);
  await q(`insert into desk.numbers (instance, label, role, state, state_at, sort, warmup_started)
    values ($1, $2, $3, 'connecting', now(), (select coalesce(max(sort), 0) + 1 from desk.numbers), $4)`, [instance, label, role, istDate()]);
  await logEvent('number.add', { instance, label, role });
  return { instance, qr: d?.qrcode?.base64 || null, pairingCode: d?.qrcode?.pairingCode || null };
}

// Never marks chats as read (no blue ticks from the dashboard) and never ignores groups.
async function createInstance(instance, number, history) {
  return evo('POST', '/instance/create', { instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true,
    ...(number ? { number } : {}), groupsIgnore: false, readMessages: false, readStatus: false, alwaysOnline: false,
    rejectCall: false, syncFullHistory: !!history }, 90000);
}

// QR for linking. When a phone number is given, Evolution returns an 8-character pairing code
// instead, for linking from WhatsApp's "Link with phone number" screen.
//
// A connection is only ever started when a person asks for one (start = true), never by polling.
// On 28 Sep 2026 a dialog that restarted "closed" connections by itself opened a second socket
// while Evolution was already reconnecting after pairing; the two kicked each other off 280 times
// ("conflict: replaced") until WhatsApp removed the device. Hence: no restart within 30 seconds
// of the last one, and none while the number was connected a moment ago (Evolution reconnects
// it on its own).
const lastStart = new Map(), lastOpen = new Map();
export function noteState(instance, state) { if (state === 'open') lastOpen.set(instance, Date.now()); }

export async function linkInfo(instance, phoneForCode, { start = false } = {}) {
  const n = await one(`select * from desk.numbers where instance = $1`, [instance]);
  if (!n) throw httpError(404, 'Unknown number');
  const state = await connectionState(instance);
  noteState(instance, state);
  if (state === 'open') { await refreshOwner(instance); return { state }; }
  if (state === 'missing') throw httpError(404, 'This number no longer exists in Evolution');
  if (state === 'unreachable') throw httpError(502, 'Evolution is not answering');
  let number = null;
  if (phoneForCode) {
    const p = normalizePhone(phoneForCode);
    if (!p.ok) throw httpError(400, `Phone number: ${p.reason}`);
    number = p.phone;
  }
  // Evolution only takes a phone number when a connection starts. A number that has never
  // been linked holds nothing yet, so its instance is simply created again with the phone.
  if (number && state === 'connecting') {
    if (n.phone) throw httpError(409, 'This number was linked before. Log it out first, then ask for a code.');
    await evo('DELETE', `/instance/delete/${encodeInstance(instance)}`).catch(() => {});
    lastStart.set(instance, Date.now());
    const d = await createInstance(instance, number, true);
    return { state: 'connecting', qr: d?.qrcode?.base64 || null, pairingCode: d?.qrcode?.pairingCode || null };
  }
  if (state === 'connecting') {
    // Safe: while connecting, Evolution hands back the current QR without restarting anything.
    const d = await evo('GET', `/instance/connect/${encodeInstance(instance)}`);
    return { state, qr: d?.base64 || null, pairingCode: d?.pairingCode || null };
  }
  // Closed.
  const since = x => Date.now() - (x || 0);
  if (!start && !number) return { state, needsStart: true };
  if (since(lastOpen.get(instance)) < 90000) return { state, reconnecting: true };
  if (since(lastStart.get(instance)) < 30000) return { state, starting: true };
  lastStart.set(instance, Date.now());
  const d = await evo('GET', `/instance/connect/${encodeInstance(instance)}${number ? `?number=${number}` : ''}`);
  return { state: await connectionState(instance), qr: d?.base64 || null, pairingCode: d?.pairingCode || null };
}

async function refreshOwner(instance) {
  try {
    const list = await fetchInstances();
    const x = list.find(i => (i.name || i.instanceName) === instance);
    if (!x) return;
    const phone = digitsOf(x.ownerJid || '');
    await q(`update desk.numbers set phone = coalesce($2, phone), profile_name = coalesce($3, profile_name), state = 'open', state_at = now()
      where instance = $1`, [instance, phone && phone.length >= 8 ? phone : null, x.profileName || null]);
  } catch {}
}

export async function updateNumber(instance, body) {
  const n = await one(`select * from desk.numbers where instance = $1`, [instance]);
  if (!n) throw httpError(404, 'Unknown number');
  const label = body.label !== undefined ? String(body.label).trim().slice(0, 60) || n.label : n.label;
  const role = ROLES.includes(body.role) ? body.role : n.role;
  const cap = body.daily_cap !== undefined ? Math.max(0, Math.min(200, Math.round(Number(body.daily_cap)) || 0)) : n.daily_cap;
  const active = body.active !== undefined ? !!body.active : n.active;
  const notes = body.notes !== undefined ? String(body.notes).slice(0, 1000) : n.notes;
  // "warmed": true ends the warm-up by hand; false starts it again from today.
  const warm = body.warmed === true ? null : body.warmed === false ? istDate() : n.warmup_started;
  if (role === 'reader' && n.role !== 'reader') {
    const slice = await one(`select count(*)::int n from desk.resellers where instance = $1 and group_jid is not null`, [instance]);
    if (slice.n) throw httpError(409, `This number still sends to ${slice.n} reseller groups. Move its slice first; the reader never sends.`);
  }
  await q(`update desk.numbers set label = $2, role = $3, daily_cap = $4, active = $5, notes = $6, warmup_started = $7 where instance = $1`,
    [instance, label, role, cap, active, notes, warm]);
  await logEvent('number.update', { instance, label, role, cap, active, warmed: body.warmed });
  return { ok: true };
}

export async function logoutNumber(instance) {
  await evo('DELETE', `/instance/logout/${encodeInstance(instance)}`).catch(e => { if (e.evoStatus !== 400) throw e; });
  await q(`update desk.numbers set state = 'close', state_at = now() where instance = $1`, [instance]);
  await logEvent('number.logout', { instance });
  return { ok: true };
}

export async function removeNumber(instance) {
  const slice = await one(`select count(*)::int n from desk.resellers where instance = $1 and group_jid is not null`, [instance]);
  if (slice.n > 0) throw httpError(409, `This number still owns ${slice.n} reseller groups. Move its slice to another number first.`);
  await evo('DELETE', `/instance/logout/${encodeInstance(instance)}`).catch(() => {});
  await evo('DELETE', `/instance/delete/${encodeInstance(instance)}`).catch(e => { if (e.evoStatus !== 404) throw e; });
  await tx(async t => {
    await t(`delete from desk.group_members where instance = $1`, [instance]);
    await t(`delete from desk.groups where instance = $1`, [instance]);
    await t(`delete from desk.numbers where instance = $1`, [instance]);
  });
  await logEvent('number.remove', { instance });
  return { ok: true };
}

// ---------------------------------------------------------------- groups and members
// One WhatsApp query per number (Evolution is patched so the call does not fan out).
export async function refreshGroups(instance) {
  const list = await evo('GET', `/group/fetchAllGroups/${encodeInstance(instance)}?getParticipants=true`, null, 90000);
  if (!Array.isArray(list)) throw new Error('fetchAllGroups did not return a list');
  const firstSync = !(await one(`select 1 from desk.meta where key = $1`, [`groups_synced:${instance}`]));
  const seen = [];
  await tx(async t => {
    for (const g of list) {
      if (!g?.id?.endsWith('@g.us')) continue;
      seen.push(g.id);
      await t(`insert into desk.groups (instance, jid, subject, size, announce, is_community, is_community_announce, left_group, synced_at, preexisting)
        values ($1,$2,$3,$4,$5,$6,$7,false,now(),$8)
        on conflict (instance, jid) do update set subject = excluded.subject, size = excluded.size, announce = excluded.announce,
          is_community = excluded.is_community, is_community_announce = excluded.is_community_announce, left_group = false, synced_at = now()`,
        [instance, g.id, g.subject || null, g.size ?? (g.participants || []).length, !!g.announce, !!g.isCommunity, !!g.isCommunityAnnounce, firstSync]);
      if (Array.isArray(g.participants)) await saveMembers(t, instance, g.id, g.participants);
    }
    if (list.length) await t(`update desk.groups set left_group = true where instance = $1 and not (jid = any($2))`, [instance, seen]);
  });
  await q(`insert into desk.meta (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`,
    [`groups_synced:${instance}`, JSON.stringify(now())]);
  return { groups: seen.length, firstSync };
}

// Members of one group, for a group the number just joined.
export async function refreshOneGroup(instance, jid) {
  const g = await evo('GET', `/group/findGroupInfos/${encodeInstance(instance)}?groupJid=${encodeURIComponent(jid)}`, null, 30000);
  if (!g?.id) return false;
  await tx(async t => {
    await t(`insert into desk.groups (instance, jid, subject, size, announce, is_community, is_community_announce, left_group, synced_at)
      values ($1,$2,$3,$4,$5,$6,$7,false,now())
      on conflict (instance, jid) do update set subject = excluded.subject, size = excluded.size, left_group = false, synced_at = now()`,
      [instance, g.id, g.subject || null, g.size ?? (g.participants || []).length, !!g.announce, !!g.isCommunity, !!g.isCommunityAnnounce]);
    if (Array.isArray(g.participants)) await saveMembers(t, instance, g.id, g.participants);
  });
  return true;
}

async function saveMembers(t, instance, jid, participants) {
  await t(`delete from desk.group_members where instance = $1 and jid = $2`, [instance, jid]);
  const ps = participants.filter(p => p?.id);
  if (!ps.length) return;
  const ids = ps.map(p => p.id), phones = ps.map(p => digitsOf(p.phoneNumber || (String(p.id).endsWith('@s.whatsapp.net') ? p.id : '')) || null),
    admins = ps.map(p => p.admin || null);
  await t(`insert into desk.group_members (instance, jid, member_id, phone, admin)
    select $1, $2, u.id, u.phone, u.admin from unnest($3::text[], $4::text[], $5::text[]) as u(id, phone, admin) on conflict do nothing`,
    [instance, jid, ids, phones, admins]);
  await t(`insert into desk.lid_map (lid, phone) select u.id, u.phone from unnest($1::text[], $2::text[]) as u(id, phone)
    where u.id like '%@lid' and u.phone is not null on conflict (lid) do update set phone = excluded.phone, seen_at = now()`, [ids, phones]);
}

// Groups that exist in Evolution's chats but that the desk has no members for yet.
export async function newGroupJids(instance) {
  return (await q(`select distinct c."remoteJid" jid from evolution_api."Chat" c join evolution_api."Instance" i on i.id = c."instanceId"
    where i.name = $1 and c."remoteJid" like '%@g.us'
      and not exists (select 1 from desk.groups g where g.instance = $1 and g.jid = c."remoteJid")`, [instance])).map(r => r.jid);
}

// Learn lid -> phone from the mapping files Evolution keeps for every number. WhatsApp hands
// these over when a number links, so ad leads and new chats show a real phone number.
export async function learnLidsFromFiles() {
  const { lidPhoneMap } = await import('./adleads.mjs');
  const map = lidPhoneMap();
  if (!map.size) return { learned: 0 };
  const lids = [...map.keys()].map(l => `${l}@lid`), phones = [...map.values()];
  const r = await q(`insert into desk.lid_map (lid, phone) select * from unnest($1::text[], $2::text[])
    on conflict (lid) do update set phone = excluded.phone where desk.lid_map.phone is distinct from excluded.phone returning lid`, [lids, phones]);
  return { learned: r.length, known: map.size };
}

// Learn lid -> phone from messages (live messages carry both ids since Baileys 7).
export async function learnLidsFromMessages() {
  await q(`insert into desk.lid_map (lid, phone)
    select distinct on (lid) lid, phone from (
      select m.key->>'participant' lid, split_part(m.key->>'participantAlt', '@', 1) phone from evolution_api."Message" m
        where m.key->>'participant' like '%@lid' and m.key->>'participantAlt' like '%@s.whatsapp.net'
      union all
      select m.key->>'remoteJid', split_part(m.key->>'remoteJidAlt', '@', 1) from evolution_api."Message" m
        where m.key->>'remoteJid' like '%@lid' and m.key->>'remoteJidAlt' like '%@s.whatsapp.net') x
    order by lid
    on conflict (lid) do update set phone = excluded.phone`);
}

// Everyone we share a group with, and whether they are on our side: our numbers, the team,
// the other company numbers, and anyone in two or more of our groups (34, 74).
// "Our groups" are the reseller groups: the groups bound to a reseller row. A number that
// was linked with its own old groups (community groups, other clients) must not turn
// everyone who shares two of those into "one of ours": their replies would stop counting.
export async function rebuildPeople() {
  const s = await getSettings();
  const numbers = await q(`select phone from desk.numbers where phone is not null`);
  const own = new Map();
  for (const n of numbers) own.set(n.phone, 'connected number');
  for (const [p, name] of Object.entries(s.extra_own_numbers || {})) own.set(p, `company number${name ? ` (${name})` : ''}`);
  const team = Object.keys(s.team_numbers || {});
  await tx(async t => {
    await t(`delete from desk.people`);
    await t(`insert into desk.people (member_id, phone, group_count)
      select gm.member_id, coalesce(max(gm.phone), max(lm.phone)),
        count(distinct gm.jid) filter (where exists (select 1 from desk.resellers r where r.group_jid = gm.jid))::int
      from desk.group_members gm join desk.groups g on g.instance = gm.instance and g.jid = gm.jid and not g.left_group
        left join desk.lid_map lm on lm.lid = gm.member_id
      group by gm.member_id`);
    await t(`update desk.people p set name = coalesce(
        (select c."pushName" from evolution_api."Contact" c where c."remoteJid" = p.member_id and c."pushName" !~ '^[0-9]+$' limit 1),
        (select c."pushName" from evolution_api."Contact" c where p.phone is not null and c."remoteJid" = p.phone || '@s.whatsapp.net' and c."pushName" !~ '^[0-9]+$' limit 1))`);
    await t(`update desk.people set is_team = coalesce(phone = any($1), false),
      is_ours = coalesce(phone = any($1), false) or coalesce(phone = any($2), false) or group_count >= 2`, [team, [...own.keys()]]);
    for (const [phone, name] of Object.entries(s.team_numbers || {})) {
      if (name) await t(`update desk.people set name = coalesce(name, $2) where phone = $1`, [phone, name]);
    }
    await t(`delete from desk.our_phones`);
    await t(`insert into desk.our_phones (phone, why) select u.p, u.w from unnest($1::text[], $2::text[]) u(p, w) on conflict do nothing`,
      [[...own.keys()], [...own.values()]]);
    await t(`insert into desk.our_phones (phone, why) select u.p, 'team' from unnest($1::text[]) u(p) on conflict do nothing`, [team]);
    await t(`insert into desk.our_phones (phone, why) select distinct phone, 'in two or more of our groups' from desk.people
      where group_count >= 2 and phone is not null on conflict do nothing`);
  });
  // Each number's own WhatsApp id, so its own messages in groups are recognised.
  await q(`update desk.numbers n set lid = (select gm.member_id from desk.group_members gm where gm.phone = n.phone and gm.member_id like '%@lid' limit 1)
    where n.phone is not null`);
}
