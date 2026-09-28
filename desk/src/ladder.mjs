// Stage 6 - building the message: the two ladders, the rate card and the five heading styles.
import { q, one, tx, logEvent } from './db.mjs';
import { httpError } from './util.mjs';

export const RINGS = ['follow_up', 'offer'];
// Any bracketed span is unwritten copy; a rung that still has one is held, never sent.
export const PLACEHOLDER_RE = /\[[^\]]*\]/;
const TOKEN_RE = /\{(heading|package|price|outlets|outlet_list|lead|reach|tat|sample|business)\}/g;

// ---------------------------------------------------------------- defaults
// The follow-up ladder is finished copy from the reseller build. The offer ladder is built
// from the rate card with tokens; its bracketed lines must be finished before it sends.
const DEFAULT_FOLLOW_UPS = [
  ['F1-checkin', `Quick check-in from our side, nothing pending.
How is the PR side looking for you this month?
If something is sitting with you and needs placement, send it across and I will look at it today.
If you would rather not get these, just say stop and they stop.`],
  ['F2-useful', `Something you can use with your own client: send them a one-pager with outlet name, DA and turnaround before you quote any price.
It closes faster than leading with a rate list.
Happy to send you a blank one you can put your own logo on, just say yes.
Say stop any time and these messages stop.`],
  ['F3-question', `One question so I stop guessing what to send you.
Which do your clients ask for more, national business outlets or regional and language ones? One word is enough.
Say stop any time and these messages stop.`],
  ['F4-proof', `No client names, but a fair proof point. The last set of reseller releases we handled all went live inside the window we quoted.
Each came back with the live link and a screenshot the same day it published.
That is usually where resellers get burnt, so that is the part worth judging us on.
Say stop any time and I will not bring this up again.`],
  ['F5-close', `Last one from me on this. Is it still worth keeping in touch here, or has PR moved off your plate?
A plain no is completely fine and costs you nothing.
If it is a not right now, tell me roughly when and I will come back then instead.
Say stop and I will close this quietly.`],
];
const DEFAULT_OFFERS = [
  ['O1-entry', 1, `*{heading}*

Published on:
{outlets}

Live in {tat} after approval, with the live link report.
Sample: {sample}

Send me one release you already have and I will put it through this.
Say stop any time and I will stop sending these.`],
  ['O2-spread', 2, `*{heading}*

Published on:
{outlets}

Live in {tat}. Full pickup report with every live link.
Sample: {sample}

This is the one to quote when your client wants coverage, not one link.
Say stop any time and these stop.`],
  ['O3-wide', 5, `*{heading}*

Published on:
{outlets}

Live in {tat}. Full pickup report with every live link.
Sample: {sample}

The widest spread we run. More than one release this month? Ask me for the multi-release rate.
Say stop any time and I will not send these again.`],
];
// Rate card as it stood in the Rankkking MAINSTREAM sheet (Sep 2026). Edit on the Messages page.
const DEFAULT_PACKAGES = [
  ['Package 1', '$125', '12-24 hrs', '250+ Global General Media', 'https://finance.yahoo.com/media-advertising/articles/digital-marketing-podcast-india-jitendra-111200509.html',
    ['Yahoo Finance', 'Street Insider', 'Digital Journal']],
  ['Package 2', '$160', '12-24 hrs', '150+ Global General Media', 'https://www.usatoday.com/press-release/story/27547/gneiss-io-launches-peer-to-peer-digital-asset-marketplace-for-everyday-users/',
    ['USA Today', 'Street Insider']],
  ['Package 3', '$190', '12-24 hrs', '250+ Global General Media', '', ['Yahoo Finance', 'Street Insider', 'Digital Journal', 'APNews']],
  ['Package 4', '$270', '12-24 hrs', '250+ Global General Media', '', ['Yahoo Finance', 'Business Insider', 'Street Insider', 'Digital Journal', 'APNews']],
  ['Package 5', '$420', '24 hrs', '550+ Global General Media', '',
    ['Yahoo Finance', 'Manilatimes.net', 'Business Insider', 'Street Insider', 'APNews', 'Benzinga', 'Marketwatch']],
];
const DEFAULT_HEADINGS = [
  "This week's PR offer: {lead} plus {reach} for {price}",
  'Offer for this week: {lead} coverage at {price}',
  "This week we're placing on {lead} and {reach} for {price}",
  '{price} this week for {lead} and {reach}',
  'Running this week: {lead} plus {reach} for {price}',
];

export async function seedLadder() {
  const [{ n }] = await q(`select count(*)::int n from desk.rungs`);
  if (n > 0) return;
  await tx(async t => {
    const pkgIds = [];
    for (const [i, [label, price, tat, reach, sample, outlets]] of DEFAULT_PACKAGES.entries()) {
      const [p] = await t(`insert into desk.rate_packages (label, price, tat, reach, sample_url, sort) values ($1,$2,$3,$4,$5,$6) returning id`,
        [label, price, tat, reach, sample, i + 1]);
      pkgIds.push(p.id);
      for (const [j, o] of outlets.entries()) await t(`insert into desk.rate_outlets (package_id, name, sort) values ($1,$2,$3)`, [p.id, o, j + 1]);
    }
    for (const [i, h] of DEFAULT_HEADINGS.entries()) await t(`insert into desk.headings (template, sort) values ($1,$2)`, [h, i + 1]);
    for (const [i, [label, body]] of DEFAULT_FOLLOW_UPS.entries()) {
      await t(`insert into desk.rungs (ring, position, label, template) values ('follow_up', $1, $2, $3)`, [i + 1, label, body]);
    }
    for (const [i, [label, pkg, body]] of DEFAULT_OFFERS.entries()) {
      await t(`insert into desk.rungs (ring, position, label, template, package_id) values ('offer', $1, $2, $3, $4)`, [i + 1, label, body, pkgIds[pkg - 1]]);
    }
  });
}

// ---------------------------------------------------------------- read
export async function ladderState() {
  const packages = await q(`select * from desk.rate_packages order by sort, id`);
  const outlets = await q(`select * from desk.rate_outlets order by package_id, sort, id`);
  for (const p of packages) p.outlets = outlets.filter(o => o.package_id === p.id);
  const headings = await q(`select * from desk.headings order by sort, id`);
  const rungs = await q(`select r.*, (select count(*)::int from desk.send_log s where s.rung_label = r.label) sent_count
    from desk.rungs r order by r.ring, r.position, r.id`);
  for (const r of rungs) r.problem = rungProblem(r, packages);
  return { packages, headings, rungs };
}

export function rungProblem(rung, packages) {
  if (PLACEHOLDER_RE.test(rung.template)) return 'has unfinished [bracketed] copy';
  if (/@\d/.test(rung.template)) return 'contains an @mention; tags are added at send time';
  const tokens = [...rung.template.matchAll(TOKEN_RE)].map(m => m[1]).filter(t => t !== 'business' && t !== 'heading');
  if ((tokens.length || /\{heading\}/.test(rung.template)) && !rung.package_id) return 'uses rate-card tokens but has no package';
  if (rung.package_id) {
    const p = packages.find(x => x.id === rung.package_id);
    if (!p) return 'its package was deleted';
    if (!p.active) return `package ${p.label} is switched off`;
    if (!p.outlets.some(o => o.available)) return `package ${p.label} has no available outlet`;
  }
  return null;
}

// Build the text for one rung. The internal package label never appears in it.
export function renderRung(rung, pkg, heading, business) {
  const avail = pkg ? pkg.outlets.filter(o => o.available).map(o => o.name) : [];
  const vals = {
    business: business || '',
    package: pkg ? `${avail[0] || ''}${avail.length > 1 ? ` + ${avail.length - 1} more` : ''}` : '',
    price: pkg?.price || '', tat: pkg?.tat || '', reach: pkg?.reach || '', sample: pkg?.sample_url || '',
    lead: avail[0] || '', outlets: avail.map(o => `• ${o}`).join('\n') + (pkg?.reach ? `\n• plus ${pkg.reach}` : ''),
    outlet_list: avail.join(', '),
  };
  const fill = s => s.replace(TOKEN_RE, (_, k) => vals[k] ?? '');
  vals.heading = heading ? fill(heading.template) : '';
  let text = fill(rung.template);
  // A token with nothing behind it would leave "Sample: " dangling; drop that line.
  text = text.split('\n').filter(l => !/^(Sample|Live sample):\s*$/.test(l.trim())).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- write
export async function savePackage(b) {
  const label = String(b.label || '').trim().slice(0, 60);
  if (!label) throw httpError(400, 'Package name is empty');
  const vals = [label, String(b.price || '').slice(0, 40), String(b.tat || '').slice(0, 40), String(b.reach || '').slice(0, 80),
    String(b.sample_url || '').slice(0, 500), b.active !== false];
  if (vals[4] && !/^https?:\/\//.test(vals[4])) throw httpError(400, 'The sample link must start with http');
  const outlets = (Array.isArray(b.outlets) ? b.outlets : []).map(o => ({ name: String(o.name || '').trim().slice(0, 80), available: o.available !== false }))
    .filter(o => o.name);
  return tx(async t => {
    let id = b.id;
    if (id) await t(`update desk.rate_packages set label=$2, price=$3, tat=$4, reach=$5, sample_url=$6, active=$7 where id=$1`, [id, ...vals]);
    else [{ id }] = await t(`insert into desk.rate_packages (label, price, tat, reach, sample_url, active, sort)
      values ($1,$2,$3,$4,$5,$6,(select coalesce(max(sort),0)+1 from desk.rate_packages)) returning id`, vals);
    await t(`delete from desk.rate_outlets where package_id = $1`, [id]);
    for (const [i, o] of outlets.entries()) await t(`insert into desk.rate_outlets (package_id, name, available, sort) values ($1,$2,$3,$4)`, [id, o.name, o.available, i + 1]);
    return { id };
  });
}

export async function deletePackage(id) {
  await q(`delete from desk.rate_packages where id = $1`, [id]);
  return { ok: true };
}

export async function saveHeadings(list) {
  const h = (Array.isArray(list) ? list : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 12);
  if (h.length < 1) throw httpError(400, 'Keep at least one heading style');
  await tx(async t => {
    await t(`delete from desk.headings`);
    for (const [i, x] of h.entries()) await t(`insert into desk.headings (template, sort) values ($1,$2)`, [x, i + 1]);
  });
  return { count: h.length };
}

// Labels are identity: the send record uses them to stop a group getting the same message twice.
export async function saveRung(b) {
  const ring = RINGS.includes(b.ring) ? b.ring : null;
  if (!ring) throw httpError(400, 'Choose the follow-up or the offer ladder');
  const label = String(b.label || '').trim().slice(0, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(label)) throw httpError(400, 'Label: letters, numbers, spaces, - and _ only');
  const template = String(b.template || '').trim();
  if (!template) throw httpError(400, 'The message is empty');
  if (template.length > 3000) throw httpError(400, 'The message is longer than 3000 characters');
  const pkg = b.package_id ? Number(b.package_id) : null;
  if (b.id) {
    const old = await one(`select * from desk.rungs where id = $1`, [b.id]);
    if (!old) throw httpError(404, 'Unknown message');
    const sent = await one(`select count(*)::int n from desk.send_log where rung_label = $1`, [old.label]);
    if (old.label !== label && sent.n > 0) throw httpError(409, `"${old.label}" has already been sent ${sent.n} times; its label cannot change or those groups could get it again. Edit the text instead.`);
    await q(`update desk.rungs set ring=$2, label=$3, template=$4, package_id=$5, active=$6 where id=$1`, [b.id, ring, label, template, pkg, b.active !== false]);
  } else {
    if (await one(`select 1 from desk.rungs where label = $1`, [label])) throw httpError(409, `A message labelled "${label}" already exists`);
    await q(`insert into desk.rungs (ring, position, label, template, package_id, active)
      values ($1, (select coalesce(max(position),0)+1 from desk.rungs where ring = $1), $2, $3, $4, $5)`, [ring, label, template, pkg, b.active !== false]);
  }
  await logEvent('ladder.save', { ring, label });
  await reviveExhausted();
  return { ok: true };
}

export async function moveRung(id, dir) {
  const r = await one(`select * from desk.rungs where id = $1`, [id]);
  if (!r) throw httpError(404, 'Unknown message');
  const other = await one(`select * from desk.rungs where ring = $1 and position ${dir < 0 ? '<' : '>'} $2 order by position ${dir < 0 ? 'desc' : 'asc'} limit 1`, [r.ring, r.position]);
  if (!other) return { ok: true };
  await tx(async t => {
    await t(`update desk.rungs set position = $2 where id = $1`, [r.id, other.position]);
    await t(`update desk.rungs set position = $2 where id = $1`, [other.id, r.position]);
  });
  return { ok: true };
}

export async function deleteRung(id) {
  const r = await one(`select * from desk.rungs where id = $1`, [id]);
  if (!r) return { ok: true };
  const sent = await one(`select count(*)::int n from desk.send_log where rung_label = $1`, [r.label]);
  if (sent.n > 0) throw httpError(409, `"${r.label}" has been sent ${sent.n} times. Switch it off instead of deleting, so the record keeps its name.`);
  await q(`delete from desk.rungs where id = $1`, [id]);
  return { ok: true };
}

// 123: an exhausted group comes back when a new message is added to its ladder.
export async function reviveExhausted() {
  await q(`update desk.resellers r set stage = 'live', updated_at = now()
    where r.stage = 'exhausted' and r.track is not null and exists (
      select 1 from desk.rungs g where g.ring = r.track and g.active
        and not exists (select 1 from desk.send_log s where s.reseller_id = r.id and s.rung_label = g.label))`);
}
