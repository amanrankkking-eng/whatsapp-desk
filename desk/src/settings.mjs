// Settings with defaults from the reseller flow ("Every Step, Start to End", 22 Sep 2026).
import { q } from './db.mjs';
import { httpError } from './util.mjs';

export const DEFAULTS = {
  // Stage 5 - the six checks
  min_gap_days: 10,            // 58: at least 10 days since we last messaged the group
  client_active_days: 7,       // 60: the reseller wrote recently = live conversation
  our_active_days: 3,          // 60: we wrote recently = a person is already on it
  ball_in_court_days: 21,      // 61: the reseller had the last word within this many days
  // Stage 7 - sending
  send_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  window_start: '10:30',
  window_end: '17:30',
  gap_min_sec: 301,            // 81: random gap 5-14 minutes, one at a time per number
  gap_max_sec: 840,
  daily_cap_total: 40,         // 84: ~10 per sender at four senders
  // Stage 0 - a new number is warmed for about three weeks before it carries real traffic
  warmup_days: 21,
  // Stage 0 / 4 - rings and batches
  batch_size: 20,
  ring_min_batches: 16,        // 105: a small pool pads the ring with rest days so the gap holds
  // Stage 6 - tagging
  tag_cooldown_days: 7,        // 76
  // Stage 11 - alerts
  alert_repeat_min: 30,        // 12: repeats until the owner acknowledges
  alert_hours: ['09:00', '21:00'],
  // who is ours
  team_numbers: {},            // phone -> name. Never tagged, never counted as a reseller.
  extra_own_numbers: {},       // other company numbers that are not connected here
  never_send_names: ['test', 'testing', 'test group', 'shersth bharath'], // 12: blocked by exact name (case-insensitive)
  exclude_name_words: ['01wire'],   // a name containing one of these is never in the pool
  // outputs
  team_chat_webhook: '',       // Stage 9: Google Chat space for the team summary
  intro_template: 'Hi, this is {sender_name} from Rankkking. I will be writing to you from this number from now on.',
  greeting_template: 'Hi @{tag}',
  business_name: 'Rankkking',
};

export async function getSettings() {
  const rows = await q(`select key, value from desk.meta where key like 'setting:%'`);
  const s = structuredClone(DEFAULTS);
  for (const r of rows) {
    const k = r.key.slice(8);
    if (k in DEFAULTS) s[k] = r.value;
  }
  return s;
}

const NUMS = {
  min_gap_days: [0, 60], client_active_days: [0, 60], our_active_days: [0, 60], ball_in_court_days: [0, 120],
  gap_min_sec: [30, 3600], gap_max_sec: [30, 7200], daily_cap_total: [0, 500], batch_size: [1, 200],
  ring_min_batches: [1, 200], tag_cooldown_days: [0, 60], alert_repeat_min: [5, 1440], warmup_days: [0, 90],
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function saveSettings(input) {
  const s = await getSettings();
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(NUMS)) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw httpError(400, `${k} must be a number between ${lo} and ${hi}`);
    out[k] = Math.round(v);
  }
  for (const k of ['window_start', 'window_end']) {
    if (input[k] === undefined) continue;
    if (!TIME.test(String(input[k]))) throw httpError(400, `${k} must look like 10:30`);
    out[k] = String(input[k]);
  }
  if (Array.isArray(input.alert_hours)) {
    if (input.alert_hours.length !== 2 || !input.alert_hours.every(t => TIME.test(String(t)))) throw httpError(400, 'alert_hours must be two times like 09:00');
    out.alert_hours = input.alert_hours.map(String);
  }
  if (Array.isArray(input.send_days)) {
    const d = input.send_days.filter(x => DAYS.includes(x));
    out.send_days = DAYS.filter(x => d.includes(x));
  }
  const phoneMap = v => Object.fromEntries(Object.entries(v || {}).map(([k, n]) => [String(k).replace(/\D/g, ''), String(n || '').slice(0, 80)])
    .filter(([k]) => k.length >= 8 && k.length <= 15));
  if (input.team_numbers && typeof input.team_numbers === 'object') out.team_numbers = phoneMap(input.team_numbers);
  if (input.extra_own_numbers && typeof input.extra_own_numbers === 'object') out.extra_own_numbers = phoneMap(input.extra_own_numbers);
  const list = v => v.map(x => String(x).trim()).filter(Boolean).slice(0, 200);
  if (Array.isArray(input.never_send_names)) out.never_send_names = list(input.never_send_names).map(x => x.toLowerCase());
  if (Array.isArray(input.exclude_name_words)) out.exclude_name_words = list(input.exclude_name_words).map(x => x.toLowerCase());
  for (const k of ['team_chat_webhook']) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).trim();
    if (v && !/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^\s]+$/.test(v)) throw httpError(400, 'The chat webhook must be a Google Chat webhook URL (https://chat.googleapis.com/v1/spaces/...)');
    out[k] = v;
  }
  for (const k of ['intro_template', 'greeting_template', 'business_name']) {
    if (input[k] === undefined) continue;
    out[k] = String(input[k]).slice(0, 500);
  }
  const merged = { ...s, ...out };
  if (merged.gap_max_sec < merged.gap_min_sec) throw httpError(400, 'The maximum gap must be at least the minimum gap');
  if (merged.window_end <= merged.window_start) throw httpError(400, 'The sending window must end after it starts');
  for (const [k, v] of Object.entries(out)) {
    await q(`insert into desk.meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [`setting:${k}`, JSON.stringify(v)]);
  }
  return merged;
}

export async function metaGet(key, def = null) {
  const [r] = await q(`select value from desk.meta where key = $1`, [key]);
  return r ? r.value : def;
}
export async function metaSet(key, value) {
  await q(`insert into desk.meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)]);
}
