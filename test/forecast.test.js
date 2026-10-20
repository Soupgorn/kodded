const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Database = require('better-sqlite3');
const { ChannelType, Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { openDatabase } = require('../src/database');
const { DEFAULTS, forecastPolicy, parseForecast } = require('../src/services/forecast-policy');
const { createMonitor } = require('../src/services/reset-monitor');
const { deliverForecastPending, forecastEmbed } = require('../src/services/notification-service');
const { installCommands } = require('../commands');
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';
const RESET = '2026-10-15T07:00:00.000Z';
function fixture(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kodded-forecast-'));
  let clock = Date.parse('2026-10-15T08:00:00.000Z');
  const path = join(dir, 'kodded.sqlite');
  const options = { now: () => clock, env };
  let store = openDatabase(path, options);
  t.after(() => { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); });
  function data(p24 = 30, p48 = 45, extra = {}) {
    return { probabilities: { rounded_24h: p24, rounded_48h: p48 }, confidence: 'medium', updated_at: new Date(clock).toISOString(), last_reset_at: RESET, ...extra };
  }
  function observe(p24, p48, extra) { const d = data(p24, p48, extra); store.observe(d.last_reset_at); store.observeForecast(d); return d; }
  function enable(guild = A) { store.setup(guild, C); store.enableForecast(guild, true); }
  return { get store() { return store; }, options, path, data, observe, enable, now: () => clock,
    tick: (ms = 120000) => { clock += ms; }, restart: () => { store.close(); store = openDatabase(path, options); } };
}
for (const [name, start, end] of [
  ['24h increase', [30, 45], [45, 45]], ['48h increase', [30, 45], [30, 65]]
]) test(name, t => {
  const f = fixture(t); f.observe(...start); f.enable(); f.tick(); f.observe(...end);
  const pending = f.store.pendingForecast(); assert.equal(pending.length, 1);
  assert.equal(pending[0].baseline_24h, start[0]); assert.equal(pending[0].baseline_48h, start[1]);
});
test('small changes and increases below minimum probabilities remain silent', t => {
  const f = fixture(t); f.observe(50, 55); f.enable(); f.tick(); f.observe(53, 58);
  assert.equal(f.store.pendingForecast().length, 0);
  f.tick(); f.observe(20, 30); f.tick(); f.observe(35, 50);
  assert.equal(f.store.pendingForecast().length, 0);
});
test('gradual cumulative increases reach inclusive thresholds', t => {
  const f = fixture(t); f.observe(30, 45); f.enable();
  for (const p of [33, 36, 39]) { f.tick(); f.observe(p, 45); assert.equal(f.store.pendingForecast().length, 0); }
  f.tick(); f.observe(40, 45); assert.equal(f.store.pendingForecast().length, 1);
});
test('meaningful decreases re-arm baselines while small oscillations do not', t => {
  const f = fixture(t); f.observe(50, 70); f.enable(); f.tick(); f.observe(45, 65); f.tick(); f.observe(55, 70);
  assert.equal(f.store.pendingForecast().length, 0);
  f.tick(); f.observe(35, 50); f.tick(); f.observe(45, 65);
  assert.equal(f.store.pendingForecast().length, 1);
  assert.equal(f.store.pendingForecast()[0].baseline_24h, 35);
});
test('cooldown begins on successful send, persists and requires a fresh changed snapshot after expiry', t => {
  const f = fixture(t); f.observe(); f.enable(); f.tick(); f.observe(45, 60);
  assert.equal(f.store.forecastState(A).last_notified_at, null);
  f.store.deliveredForecast(f.store.pendingForecast()[0]); const sent = f.now();
  f.tick(); f.observe(60, 75); assert.equal(f.store.pendingForecast().length, 0);
  f.restart(); assert.equal(f.store.forecastState(A).last_notified_at, sent);
  f.tick(6 * 3600000); f.observe(60, 75); assert.equal(f.store.pendingForecast().length, 0);
  f.tick(); f.observe(61, 75); assert.equal(f.store.pendingForecast().length, 1);
});
test('enabled preferences and cooldowns are isolated; forecast and reset switches are independent', t => {
  const f = fixture(t); f.observe(); f.enable(); f.enable(B);
  f.store.enable(A, false); f.tick(); f.observe(45, 60);
  assert.deepEqual(f.store.pendingForecast().map(d => d.guild_id), [A, B]);
  f.store.deliveredForecast(f.store.pendingForecast()[0]);
  f.store.enableForecast(B, false); assert.equal(f.store.pendingForecast().length, 0);
  assert.equal(f.store.getGuild(B).notifications_enabled, 1);
  f.tick(); f.observe(60, 75); f.store.enableForecast(B, true);
  assert.equal(f.store.pendingForecast().length, 0); // Enabling never replays existing levels.
  f.tick(); f.observe(75, 90);
  assert.deepEqual(f.store.pendingForecast().map(d => d.guild_id), [B]);
  f.store.enableForecast(B, false); f.store.enableForecast(B, true);
  assert.equal(f.store.pendingForecast().length, 0);
  assert.equal(f.store.forecastState(A).last_notified_at !== null, true);
});
test('first observation baselines silently; repeated timestamps, values and restarts cannot duplicate a movement', t => {
  const f = fixture(t); f.store.setup(A, C);
  f.store.db.prepare('UPDATE guild_config SET forecast_alerts_enabled=1 WHERE guild_id=?').run(A);
  const initial = f.observe(75, 90); assert.equal(f.store.pendingForecast().length, 0);
  f.tick(); const raised = f.observe(85, 90); assert.equal(f.store.pendingForecast().length, 1);
  f.restart(); f.store.observeForecast(raised); assert.equal(f.store.pendingForecast().length, 1);
  f.store.deliveredForecast(f.store.pendingForecast()[0]);
  f.store.observeForecast(initial); f.store.observeForecast({ ...raised, probabilities: { rounded_24h: 100, rounded_48h: 100 } });
  f.tick(7 * 3600000); f.observe(85, 90); assert.equal(f.store.pendingForecast().length, 0);
});
test('confirmed reset clears forecasts even with missing probability fields, preserving confirmed queues and cooldown', async t => {
  const f = fixture(t); f.observe(); f.enable(); f.tick(); f.observe(45, 60);
  const reset = new Date(f.now() - 60000).toISOString();
  const monitor = createMonitor({}, f.store, { get: async () => ({ last_reset_at: reset }) });
  await monitor();
  assert.equal(f.store.pendingForecast().length, 0); assert.equal(f.store.pending().length, 1);
  assert.equal(f.store.forecastState(A).baseline_24h, null);
  f.tick(); f.observe(90, 95, { last_reset_at: reset }); assert.equal(f.store.pendingForecast().length, 0);
});
test('invalid, stale and future snapshots are ignored without damaging state; unsupported signals are not relayed', t => {
  const f = fixture(t); f.observe(); f.enable();
  for (const data of [null, {}, f.data('45', 65), f.data(NaN, 65), f.data(45, 101),
    f.data(45, null), f.data(45, 65, { updated_at: 'invalid' }),
    f.data(45, 65, { updated_at: new Date(f.now() - 11 * 60000).toISOString() }),
    f.data(45, 65, { updated_at: new Date(f.now() + 120000).toISOString() })]) {
    assert.throws(() => f.store.observeForecast(data), /missing, invalid or stale/);
  }
  assert.equal(f.store.pendingForecast().length, 0); assert.equal(f.store.forecastState(A).baseline_24h, 30);
  f.tick(); f.observe(45, 65, { confidence: '<@everyone>', official_signal: { rumor: 'unvalidated' } });
  assert.equal(f.store.pendingForecast()[0].confidence, 'Unknown');
  const json = forecastEmbed(f.store.pendingForecast()[0]).toJSON();
  assert.match(json.description, /This is a forecast, not a confirmed reset\./);
  assert.equal(json.color, 0xf5b942); assert.equal(json.footer.text, 'Kodded • Forecast Alert');
  assert.equal(json.fields[0].value, '30% → 45% (+15 pp)'); assert.ok(!JSON.stringify(json).includes('rumor'));
});
function discord(failGuild, sent) {
  return { guilds: { fetch: async id => ({ id, members: { me: {} }, channels: { fetch: async () => ({
    id: C, guildId: id, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      assert.equal(payload.content, undefined);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      if (id === failGuild()) throw new Error('Missing permissions'); sent.push(id);
    }
  }) } }) } };
}
test('failed guild retries independently across restart and API failure without re-alerting successful guilds', async t => {
  const f = fixture(t); f.observe(); f.enable(); f.enable(B); let fail = B; const sent = [];
  const client = discord(() => fail, sent); f.tick(); f.observe(45, 60);
  await deliverForecastPending(client, f.store); assert.deepEqual(sent, [A]);
  assert.deepEqual(f.store.pendingForecast().map(x => x.guild_id), [B]);
  f.restart(); fail = null;
  const monitor = createMonitor(client, f.store, { get: async () => { throw new Error('API timeout'); } });
  await monitor(); await monitor(); assert.deepEqual(sent, [A, B]); assert.equal(f.store.pendingForecast().length, 0);
});
test('pending movements do not stack and are canceled if a decrease removes the qualifying rise', t => {
  const f = fixture(t); f.observe(); f.enable(); f.tick(); f.observe(45, 60);
  f.tick(); f.observe(70, 90); assert.equal(f.store.pendingForecast().length, 1);
  f.tick(); f.observe(30, 45); assert.equal(f.store.pendingForecast().length, 0);
  f.tick(); f.observe(40, 45); assert.equal(f.store.pendingForecast().length, 1);
});
test('idempotent upgrade from original SQLite schema preserves configuration, reset queues and legacy migration marker', t => {
  const f = fixture(t); f.store.close();
  const db = new Database(f.path);
  db.exec(`DROP TABLE forecast_deliveries; DROP TABLE forecast_guild_state; DROP TABLE forecast_observation;
    ALTER TABLE guild_config DROP COLUMN forecast_alerts_enabled;
    INSERT INTO guild_config(guild_id,channel_id,last_notified_reset,baseline_reset) VALUES ('${A}','${C}','${RESET}','${RESET}');
    INSERT INTO reset_events VALUES ('2026-10-15T07:30:00.000Z');
    INSERT INTO deliveries VALUES ('${A}','2026-10-15T07:30:00.000Z');`);
  db.close();
  const upgraded = openDatabase(f.path, f.options);
  assert.equal(upgraded.getGuild(A).forecast_alerts_enabled, 0); assert.equal(upgraded.getGuild(A).channel_id, C);
  assert.equal(upgraded.getGuild(A).last_notified_reset, RESET); assert.equal(upgraded.pending().length, 1);
  assert.equal(upgraded.state('legacy_migrated'), '1'); upgraded.close();
  const again = openDatabase(f.path, f.options); assert.equal(again.pending().length, 1); again.close();
});
function interaction(sub, manage) {
  return { replies: [], commandName: 'kodded', guildId: A, isChatInputCommand: () => true, inGuild: () => true,
    options: { getSubcommand: () => sub, getSubcommandGroup: () => 'forecast-alert' },
    memberPermissions: { has: bit => manage && bit === PermissionFlagsBits.ManageGuild },
    deferReply: async function(options) { assert.equal(options.flags, MessageFlags.Ephemeral); this.deferred = true; },
    editReply: async function(payload) { this.replies.push(payload); } };
}
test('forecast commands enforce Manage Server for changes; member config is ephemeral and enabling baselines safely', async t => {
  const f = fixture(t); f.observe(); f.store.setup(A, C); const sent = [];
  const client = discord(() => null, sent), handlers = {};
  client.on = (e, fn) => { handlers[e] = fn; }; client.once = () => {};
  installCommands(client, f.store, { get: async () => f.data() });
  const run = handlers[Events.InteractionCreate];
  for (const sub of ['enable', 'disable']) { const i = interaction(sub, false); await run(i); assert.match(i.replies[0].content, /Manage Server/); }
  const config = interaction('config', false); await run(config);
  assert.match(config.replies[0].content, /Forecast alerts: Disabled/); assert.match(config.replies[0].content, /40% and \+10/); assert.match(config.replies[0].content, /6 hours/);
  await run(interaction('enable', true)); assert.equal(f.store.getGuild(A).forecast_alerts_enabled, 1); assert.equal(f.store.pendingForecast().length, 0);
  await run(interaction('disable', true)); assert.equal(f.store.getGuild(A).forecast_alerts_enabled, 0); assert.equal(f.store.getGuild(A).notifications_enabled, 1);
  f.store.removeGuild(A); const missing = interaction('enable', true); await run(missing); assert.match(missing.replies[0].content, /setup first/);
});
test('configurable defaults validate strictly and change trigger thresholds', t => {
  assert.deepEqual(forecastPolicy(), DEFAULTS);
  assert.throws(() => forecastPolicy({ FORECAST_COOLDOWN_HOURS: '0' }), /Invalid environment/);
  assert.throws(() => forecastPolicy({ FORECAST_MIN_24H: 'bad' }), /Invalid environment/);
  const f = fixture(t, { FORECAST_MIN_24H: '50', FORECAST_INCREASE_24H: '20', FORECAST_COOLDOWN_HOURS: '8' });
  f.observe(); f.enable(); f.tick(); f.observe(45, 45); assert.equal(f.store.pendingForecast().length, 0);
  f.tick(); f.observe(50, 45); assert.equal(f.store.pendingForecast().length, 1); assert.equal(f.store.forecastPolicy.cooldownMs, 8 * 3600000);
  assert.throws(() => parseForecast({}, f.now()), /missing/);
});
test('one shared poll processes both notification types and a confirmed reset silently rebaselines forecasts', async t => {
  const f = fixture(t); f.observe(); f.enable(); const sent = []; let calls = 0;
  const client = discord(() => null, sent); let data = f.data(45, 60);
  const monitor = createMonitor(client, f.store, { get: async endpoint => { if (endpoint === 'feed') return { stale: false, tweets: [], fetched_at: new Date(f.now()).toISOString() }; calls++; assert.equal(endpoint, 'forecast'); return data; } });
  f.tick(); data = f.data(45, 60); await monitor();
  assert.equal(calls, 1); assert.deepEqual(sent, [A]); assert.equal(f.store.forecastState(A).last_notified_at, f.now());
  const lastForecastSend = f.store.forecastState(A).last_notified_at;
  f.tick(); data = f.data(90, 95, { last_reset_at: new Date(f.now() - 60000).toISOString() }); await monitor();
  assert.equal(calls, 2); assert.deepEqual(sent, [A, A]); assert.equal(f.store.pending().length, 0);
  assert.equal(f.store.pendingForecast().length, 0); assert.equal(f.store.forecastState(A).baseline_24h, 90);
  assert.equal(f.store.forecastState(A).last_notified_at, lastForecastSend);
});
test('disabling forecast alerts during channel lookup prevents the send and acknowledgement', async t => {
  const f = fixture(t); f.observe(); f.enable(); f.tick(); f.observe(45, 60); const sent = [];
  const client = discord(() => null, sent), fetchGuild = client.guilds.fetch;
  client.guilds.fetch = async id => { const guild = await fetchGuild(id); f.store.enableForecast(A, false); return guild; };
  await deliverForecastPending(client, f.store);
  assert.equal(sent.length, 0); assert.equal(f.store.forecastState(A).last_notified_at, null);
});
