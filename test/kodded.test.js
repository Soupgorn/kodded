const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { openDatabase } = require('../src/database');
const { createMonitor } = require('../src/services/reset-monitor');
const { validateChannel } = require('../src/services/notification-service');
const { installCommands } = require('../commands');
const { CodexApi } = require('../src/services/api');
const { ChannelType, PermissionFlagsBits, MessageFlags, Events } = require('discord.js');
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';
const R1 = '2026-10-01T00:00:00.000Z', R2 = '2026-10-02T00:00:00.000Z', R3 = '2026-10-03T00:00:00.000Z';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kodded-test-'));
  const path = join(dir, 'test.sqlite');
  const store = openDatabase(path);
  t.after(() => { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, path };
}
test('guild isolation, updates, notification toggles and baseline', t => {
  const { store } = fixture(t);
  store.observe(R1); store.setup(A, C); store.setup(B, C);
  store.enable(B, false); store.observe(R2);
  assert.deepEqual(store.pending().map(x => x.guild_id), [A]);
  store.setup(A, B); assert.equal(store.getGuild(A).channel_id, B);
  assert.equal(store.getGuild(B).channel_id, C);
  store.enable(B, true); assert.equal(store.getGuild(B).baseline_reset, R2);
  assert.throws(() => store.setup('invalid', C));
  assert.throws(() => store.enable(C, true), /setup/);
  store.delivered(A, R2, B); store.observe(R2); store.observe(R1);
  assert.equal(store.pending().length, 0);
  assert.equal(store.getGuild(A).last_notified_reset, R2);
});
test('legacy import is idempotent, preserves JSON and never overwrites settings', t => {
  const { store, dir, path } = fixture(t); store.close();
  const legacyPath = join(dir, 'state.json'); const raw = JSON.stringify({ lastResetAt: R1 });
  writeFileSync(legacyPath, raw);
  // Start with an unmigrated database.
  let db = openDatabase(path); db.db.prepare("DELETE FROM monitor_state WHERE key='legacy_migrated'").run(); db.close();
  const options = { legacyPath, env: { DISCORD_GUILD_ID: A, DISCORD_CHANNEL_ID: C } };
  db = openDatabase(path, options);
  assert.equal(db.latest(), R1); assert.equal(db.getGuild(A).last_notified_reset, R1);
  db.observe(R1); assert.equal(db.pending().length, 0);
  db.setup(A, B); db.close(); db = openDatabase(path, options);
  assert.equal(db.getGuild(A).channel_id, B); assert.equal(readFileSync(legacyPath, 'utf8'), raw); db.close();
});
test('missing legacy variables baseline safely; corrupt legacy fails without marking migration done', t => {
  const { store, dir, path } = fixture(t);
  store.db.prepare("DELETE FROM monitor_state WHERE key='legacy_migrated'").run(); store.close();
  const legacyPath = join(dir, 'state.json'); writeFileSync(legacyPath, '{');
  assert.throws(() => openDatabase(path, { legacyPath }), /migration failed/);
  writeFileSync(legacyPath, JSON.stringify({ lastResetAt: R1 }));
  const db = openDatabase(path, { legacyPath }); assert.equal(db.latest(), R1); assert.equal(db.getGuild(A), undefined); db.close();
});
test('first launch and new guilds never replay current resets; pending persists after restart', t => {
  const { store, path } = fixture(t);
  store.setup(A, C); store.observe(R1); assert.equal(store.pending().length, 0);
  store.observe(R2); store.setup(B, C); store.close();
  const db = openDatabase(path); assert.equal(db.latest(), R2); assert.equal(db.pending().length, 1);
  db.delivered(A, R2, C); db.close();
  const reopened = openDatabase(path); reopened.observe(R2); assert.equal(reopened.pending().length, 0); reopened.close();
});
test('partial failures retry independently, even during API failure; multiple events remain queued', async t => {
  const { store } = fixture(t); store.observe(R1); store.setup(A, C); store.setup(B, C);
  let fail = true, apiFail = false, reset = R2; const sends = [];
  const client = { guilds: { fetch: async id => ({ id, members: { me: {} }, channels: { fetch: async () => ({
    id: C, guildId: id, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      assert.equal(payload.content, '@everyone');
      assert.deepEqual(payload.allowedMentions, { parse: ['everyone'] });
      assert.equal(payload.embeds[0].toJSON().title, 'Codex Global Reset Confirmed!');
      if (id === B && fail) throw new Error('Forbidden'); sends.push(id);
    }
  }) } }) } };
  const monitor = createMonitor(client, store, { get: async () => { if (apiFail) throw new Error('timeout'); return { last_reset_at: reset }; } });
  await monitor(); await monitor(); assert.deepEqual(sends, [A]);
  reset = R3; await monitor(); assert.deepEqual(sends, [A, A]);
  apiFail = true; fail = false; await monitor(); await monitor();
  assert.deepEqual(sends, [A, A, B, B]); assert.equal(store.pending().length, 0);
});
test('channel validation rejects cross-guild, invalid types and missing permissions', async () => {
  const guild = { id: A, members: { me: {} } };
  const channel = { id: C, guildId: A, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) };
  await validateChannel(guild, channel);
  await assert.rejects(validateChannel(guild, { ...channel, guildId: B }), /this server/);
  await assert.rejects(validateChannel(guild, { ...channel, type: ChannelType.PublicThread }), /text/);
  await assert.rejects(validateChannel(guild, { ...channel, permissionsFor: () => null }), /Embed Links/);
});
function fakeClient() {
  const handlers = {};
  return { handlers, once: (e, fn) => { handlers[e] = fn; }, on: (e, fn) => { handlers[e] = fn; } };
}
function interaction(sub, permission, channel) {
  const replies = [];
  return { replies, isChatInputCommand: () => true, commandName: 'kodded', guildId: A, inGuild: () => true,
    memberPermissions: { has: bit => permission && bit === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => sub, getSubcommandGroup: () => ['enable', 'disable'].includes(sub) ? 'notify' : null, getChannel: () => channel },
    deferReply: async function(payload) { assert.equal(payload.flags, MessageFlags.Ephemeral); this.deferred = true; },
    editReply: async payload => replies.push(payload) };
}
test('commands enforce Manage Server without restricting informational commands; setup validates channel', async t => {
  const { store } = fixture(t); store.observe(R1);
  const client = fakeClient(); installCommands(client, store, { get: async () => ({ last_reset_at: R1 }) });
  const run = client.handlers[Events.InteractionCreate];
  for (const sub of ['setup', 'enable', 'disable']) {
    const i = interaction(sub, false); await run(i); assert.match(i.replies[0].content, /Manage Server/);
  }
  const config = interaction('config', false); await run(config); assert.match(config.replies[0].content, /No notification/);
  const status = interaction('status', false); await run(status); assert.equal(status.replies[0].embeds.length, 1);
  const bad = interaction('setup', true, { id: C });
  bad.guild = { id: A, channels: { fetch: async () => ({ id: C, guildId: B }) } };
  await run(bad); assert.match(bad.replies[0].content, /this server/); assert.equal(store.getGuild(A), undefined);
  const good = interaction('setup', true, { id: C }); good.guild = { id: A, members: { me: {} }, channels: { fetch: async () => ({ id: C, guildId: A, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }) } };
  await run(good); assert.equal(store.getGuild(A).channel_id, C);
  await run(interaction('disable', true)); assert.equal(store.getGuild(A).notifications_enabled, 0);
  await run(interaction('enable', true)); assert.equal(store.getGuild(A).notifications_enabled, 1);
});
test('global registration preserves unrelated commands and removes only old guild codex', async t => {
  const { store } = fixture(t); const client = fakeClient(); const deleted = []; let global;
  client.application = { commands: { create: async json => { global = json; }, fetch: async () => new Map(), delete: async () => {} } };
  client.guilds = { cache: new Map([[A, { id: A, commands: { fetch: async () => new Map([['1', { id: '1', name: 'codex', type: 1 }], ['2', { id: '2', name: 'other', type: 1 }]]), delete: async id => deleted.push(id) } }]]) };
  installCommands(client, store, {}); await client.handlers[Events.ClientReady]();
  assert.equal(global.name, 'kodded'); assert.equal(global.default_member_permissions, undefined);
  assert.deepEqual(deleted, ['1']);
});
test('API caches, preserves User-Agent, coalesces calls and honors rate limits', async () => {
  let calls = 0, now = 0, limited = false;
  const api = new CodexApi('Kodded/test', async (url, options) => {
    calls++; assert.equal(options.headers['User-Agent'], 'Kodded/test'); assert.ok(options.signal);
    return { ok: !limited, status: limited ? 429 : 200, headers: { get: () => '300' }, json: async () => ({ last_reset_at: R1 }) };
  }, () => now);
  await Promise.all([api.get('forecast'), api.get('forecast')]); assert.equal(calls, 1);
  await api.get('forecast'); assert.equal(calls, 1);
  now = 120000; limited = true; await assert.rejects(api.get('forecast'), /rate limited/);
  now += 120000; await assert.rejects(api.get('timeline'), /rate limited/); assert.equal(calls, 2);
  now += 300000; limited = false; await api.get('forecast'); assert.equal(calls, 3);
});
test('monitor rejects invalid reset data and prevents overlapping poll deliveries', async t => {
  const { store } = fixture(t); store.observe(R1);
  let release, calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const check = createMonitor({}, store, { get: async endpoint => { if (endpoint === 'feed') return { stale: false, tweets: [], fetched_at: new Date().toISOString() }; calls++; await wait; return { last_reset_at: 'invalid' }; } });
  const first = check(); await check(); assert.equal(calls, 1); release(); await first;
  assert.equal(store.latest(), R1); assert.equal(store.pending().length, 0);
});
test('failed global registration keeps legacy guild commands intact', async t => {
  const { store } = fixture(t); const client = fakeClient(); let cleaned = false;
  client.application = { commands: { create: async () => { throw new Error('Unavailable'); } } };
  client.guilds = { cache: new Map([[A, { commands: { fetch: async () => { cleaned = true; } } }]]) };
  installCommands(client, store, {}); await client.handlers[Events.ClientReady]();
  await client.handlers[Events.GuildCreate]({ commands: { fetch: async () => { cleaned = true; } } });
  assert.equal(cleaned, false);
});
test('forecast/history retain data source and ephemeral responses for ordinary members', async t => {
  const { store } = fixture(t); const client = fakeClient();
  installCommands(client, store, { get: async endpoint => endpoint === 'forecast'
    ? { last_reset_at: R1, probabilities: { rounded_24h: 20, rounded_48h: 40 }, confidence: 'low', updated_at: R2 }
    : { events: [{ group: 'reset', announcement_state: 'announced', announced_at: R1, summary: 'Confirmed', url: 'https://example.com/reset' }, { group: 'reset', announcement_state: 'none' }] } });
  for (const sub of ['forecast', 'history']) {
    const i = interaction(sub, false); await client.handlers[Events.InteractionCreate](i);
    const embed = i.replies[0].embeds[0].toJSON(); assert.ok(embed.fields.some(field => field.name === 'Data Source'));
  }
});
test('graceful monitor shutdown drains an active poll and prevents further work', async t => {
  const { store } = fixture(t); let release; let calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const check = createMonitor({}, store, { get: async endpoint => { if (endpoint === 'feed') return { stale: false, tweets: [], fetched_at: new Date().toISOString() }; calls++; await wait; return { last_reset_at: R1 }; } });
  const cycle = check(); let stopped = false;
  const stop = check.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await cycle; await stop; await check();
  assert.equal(store.latest(), R1); assert.equal(calls, 1);
});
