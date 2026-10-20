const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Database = require('better-sqlite3');
const { Events, MessageFlags, PermissionFlagsBits, ChannelType } = require('discord.js');
const { openDatabase } = require('../src/database');
const { HISTORY_LIMIT, RETENTION_MS } = require('../src/database/tibo');
const { parseFeed, parsePost, safePostText } = require('../src/services/tibo-feed');
const { deliverTiboPending, tiboEmbed } = require('../src/services/notification-service');
const { createMonitor } = require('../src/services/reset-monitor');
const { CodexApi } = require('../src/services/api');
const { installCommands } = require('../commands');
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kodded-tibo-')), path = join(dir, 'test.sqlite');
  let clock = Date.parse('2026-10-15T08:00:00.000Z');
  const options = { now: () => clock }; let store = openDatabase(path, options);
  t.after(() => { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (n, extra = {}) => { const id = String(2110000000000000000n + BigInt(n)); return {
    id, at: new Date(clock - 60000 + n * 10).toISOString(), text: `Post ${n}`, url: `https://x.com/thsottiaux/status/${id}`, ...extra
  }; };
  const feed = (tweets, extra = {}) => ({ fetched_at: new Date(clock).toISOString(), stale: false, tweets, ...extra });
  return { path, options, get store() { return store; }, post, feed, now: () => clock,
    tick: (ms = 120000) => { clock += ms; },
    enable: (guild = A) => { store.setup(guild, C); store.enableTibo(guild, true); },
    restart: () => { store.close(); store = openDatabase(path, options); } };
}
function discord(fail = () => false) {
  const sent = [];
  return { sent, guilds: { fetch: async id => ({ id, members: { me: {} }, channels: { fetch: async () => ({ id: C, guildId: id,
    type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }), send: async payload => {
      assert.deepEqual(payload.allowedMentions, { parse: [] }); if (fail(id)) throw new Error('Forbidden');
      sent.push({ guild: id, embed: payload.embeds[0].toJSON() });
    } }) } }) } };
}
test('first feed initialization and first enable silently baseline historical posts', t => {
  const f = fixture(t), old = f.post(1); f.store.observeTibo(f.feed([old]));
  f.enable(); assert.equal(f.store.pendingTibo().length, 0); assert.equal(f.store.tiboState(A).baseline_sequence, 1);
  f.tick(); const next = f.post(2); f.store.observeTibo(f.feed([next, old]));
  assert.deepEqual(f.store.pendingTibo().map(d => d.post_id), [next.id]);
});
test('multiple unseen posts and replies deliver chronologically, including late-ingested older posts', async t => {
  const f = fixture(t), first = f.post(10); f.store.observeTibo(f.feed([first])); f.enable(); f.tick();
  const older = f.post(2, { at: new Date(f.now() - 3600000).toISOString(), is_reply: true });
  const next = f.post(12), reply = f.post(11, { is_reply: true });
  f.store.observeTibo(f.feed([next, first, reply, older]));
  assert.deepEqual(f.store.pendingTibo().map(d => d.post_id), [older.id, reply.id, next.id]);
  const client = discord(); await deliverTiboPending(client, f.store);
  assert.deepEqual(client.sent.map(s => s.embed.fields.find(field => field.name === 'Original post').value),
    [older, reply, next].map(p => `[View on X](${p.url})`));
});
test('duplicate and reordered items across feed fields never enqueue twice; acknowledgements survive restart', async t => {
  const f = fixture(t), first = f.post(1); f.store.observeTibo(f.feed([first])); f.enable(); f.tick();
  const next = f.post(2); const data = f.feed([next, first, next], { events: [next], signal: next });
  f.store.observeTibo(data); f.store.observeTibo(data); assert.equal(f.store.pendingTibo().length, 1);
  f.restart(); assert.equal(f.store.pendingTibo().length, 1);
  const client = discord(); await deliverTiboPending(client, f.store); f.restart();
  f.store.observeTibo(f.feed([first, next])); await deliverTiboPending(client, f.store);
  assert.equal(client.sent.length, 1); assert.equal(f.store.tiboState(A).last_notified_post, next.id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM tibo_deliveries WHERE delivered_at IS NOT NULL').get().n, 1);
});
test('guild settings are independent and re-enabling drops disabled-period history without altering other features', t => {
  const f = fixture(t); f.store.observeTibo(f.feed([f.post(1)])); f.enable(); f.store.setup(B, C);
  f.store.enable(A, false); f.tick(); f.store.observeTibo(f.feed([f.post(2)]));
  assert.deepEqual(f.store.pendingTibo().map(d => d.guild_id), [A]); assert.equal(f.store.getGuild(A).forecast_alerts_enabled, 0);
  f.store.enableTibo(A, false); assert.equal(f.store.pendingTibo().length, 0);
  f.store.enableTibo(B, true); f.tick(); f.store.observeTibo(f.feed([f.post(3)]));
  assert.deepEqual(f.store.pendingTibo().map(d => d.guild_id), [B]);
  f.store.enableTibo(A, true); assert.deepEqual(f.store.pendingTibo().map(d => d.guild_id), [B]);
  assert.equal(f.store.getGuild(A).notifications_enabled, 0);
});
test('partial failures preserve per-guild order and retry across restart without repeating successful sends', async t => {
  const f = fixture(t); f.store.observeTibo(f.feed([])); f.enable(); f.enable(B); f.tick();
  f.store.observeTibo(f.feed([f.post(2), f.post(1)])); let fail = true;
  const client = discord(id => fail && id === B); await deliverTiboPending(client, f.store);
  assert.deepEqual(client.sent.map(s => s.guild), [A, A]); assert.equal(f.store.pendingTibo().length, 2);
  f.restart(); fail = false;
  const monitor = createMonitor(client, f.store, { get: async () => { throw new Error('Network timeout'); } });
  await monitor(); await monitor(); assert.deepEqual(client.sent.map(s => s.guild), [A, A, B, B]);
  assert.equal(f.store.pendingTibo().length, 0);
});
test('stale feeds, unsupported shapes and malformed entries do not corrupt baselines', t => {
  const f = fixture(t), valid = f.post(1);
  for (const data of [null, {}, f.feed([valid], { stale: true }), f.feed([valid], { stale: 'false' }),
    f.feed([valid], { fetched_at: 'bad' }), f.feed([valid], { fetched_at: new Date(f.now() - 11 * 60000).toISOString() }),
    f.feed([valid], { fetched_at: new Date(f.now() + 120000).toISOString() }), f.feed([null, {}, { ...valid, text: null }])]) {
    assert.throws(() => f.store.observeTibo(data), /Tibo feed/);
  }
  assert.equal(f.store.tiboMonitor(), undefined);
  f.store.observeTibo(f.feed([{}, valid])); f.enable(); f.tick();
  const next = f.post(2); f.store.observeTibo(f.feed([{ ...valid, text: '' }, next]));
  assert.deepEqual(f.store.pendingTibo().map(d => d.post_id), [next.id]);
});
test('post validation rejects invalid IDs, timestamps, missing text and non-original URLs without inventing values', t => {
  const f = fixture(t), valid = f.post(1);
  for (const extra of [{ id: 2110000000000000001 }, { id: 'not-an-id' }, { at: 'bad' }, { text: '' }, { text: '\u0001' },
    { url: undefined }, { url: '' }, { url: 'https://evil.example/thsottiaux/status/' + valid.id },
    { url: 'https://x.com/another/status/' + valid.id }, { url: 'https://x.com/thsottiaux/status/2110000000000000009' },
    { url: 'http://x.com/thsottiaux/status/' + valid.id }, { url: 'https://user:pass@x.com/thsottiaux/status/' + valid.id },
    { url: 'https://x.com/thsottiaux/status/' + valid.id + '/photo/1' }]) assert.equal(parsePost({ ...valid, ...extra }, f.now()), null);
  assert.equal(parsePost({ ...valid, url: valid.url + '?s=20' }, f.now()).url, valid.url);
  assert.equal(parsePost({ ...valid, url: valid.url.replace('x.com', 'twitter.com') }, f.now()).post_id, valid.id);
});
test('post embed safely truncates content and neutralizes mentions, markdown, controls and misleading links', t => {
  const f = fixture(t), post = parsePost(f.post(1, { text: '# Reset! <@123> @everyone [click](https://evil.example) \u202e' + '😀'.repeat(1500) }), f.now());
  assert.ok(post.text.length <= 1024); assert.ok(!post.text.includes('@everyone')); assert.ok(!post.text.includes('<@'));
  assert.ok(!post.text.includes('\u202e')); assert.ok(post.text.startsWith('\\#'));
  assert.ok(!post.text.includes('[click]('));
  const embed = tiboEmbed(post).toJSON(); assert.equal(embed.title, 'New Tibo Post'); assert.equal(embed.color, 0xffffff);
  assert.equal(embed.footer, undefined); assert.equal(embed.description, undefined);
  assert.deepEqual(embed.fields, [{ name: 'Post content', value: post.text }, { name: 'Original post', value: `[View on X](${post.url})` }]);
  assert.ok(safePostText('x'.repeat(2000)).length <= 1024);
});
test('retention cap preserves deduplication after pruning and keeps new late arrivals within the retention fence', t => {
  const f = fixture(t); const posts = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => f.post(i));
  f.store.observeTibo(f.feed(posts)); f.enable();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM tibo_posts').get().n, HISTORY_LIMIT);
  const sequence = f.store.tiboMonitor().last_sequence; f.restart(); f.tick();
  f.store.observeTibo(f.feed([...posts].reverse())); assert.equal(f.store.pendingTibo().length, 0);
  assert.equal(f.store.tiboMonitor().last_sequence, sequence);
  f.store.observeTibo(f.feed([f.post(2000)])); assert.equal(f.store.pendingTibo().length, 1);
});
test('age pruning never loses pending deliveries and permanently fences retired history after acknowledgement', async t => {
  const f = fixture(t); f.store.observeTibo(f.feed([])); f.enable(); const post = f.post(1);
  f.tick(); f.store.observeTibo(f.feed([post])); f.tick(RETENTION_MS + 86400000); f.store.pruneTibo();
  assert.equal(f.store.pendingTibo().length, 1);
  const client = discord(); await deliverTiboPending(client, f.store); assert.equal(client.sent.length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM tibo_posts').get().n, 0);
  f.restart(); f.store.observeTibo(f.feed([post])); assert.equal(f.store.pendingTibo().length, 0);
  f.store.observeTibo(f.feed([{ ...post, at: new Date(f.now()).toISOString() }]));
  assert.equal(f.store.pendingTibo().length, 0); // Changed upstream timestamps cannot resurrect a retired ID.
  assert.equal(f.store.tiboState(A).last_notified_post, post.id);
});
test('migration from forecast schema is idempotent and preserves channels, preferences, all old queues and legacy state', t => {
  const f = fixture(t); f.store.setup(A, C); f.store.observe('2026-10-14T00:00:00Z'); f.store.observe('2026-10-15T00:00:00Z');
  f.store.db.prepare('UPDATE guild_config SET forecast_alerts_enabled=1').run();
  f.store.db.prepare("INSERT INTO forecast_deliveries VALUES (?, ?, ?, 30, 45, 45, 60, 'medium')").run(A, new Date(f.now()).toISOString(), '2026-10-15T00:00:00.000Z');
  f.store.close(); const db = new Database(f.path);
  db.exec('DROP TABLE tibo_deliveries; DROP TABLE tibo_guild_state; DROP TABLE tibo_posts; DROP TABLE tibo_monitor; ALTER TABLE guild_config DROP COLUMN tibo_notifications_enabled;'); db.close();
  const upgraded = openDatabase(f.path, f.options);
  assert.equal(upgraded.getGuild(A).channel_id, C); assert.equal(upgraded.getGuild(A).tibo_notifications_enabled, 0);
  assert.equal(upgraded.getGuild(A).forecast_alerts_enabled, 1); assert.equal(upgraded.pending().length, 1); assert.equal(upgraded.pendingForecast().length, 1);
  assert.equal(upgraded.state('legacy_migrated'), '1'); upgraded.close();
  const again = openDatabase(f.path, f.options); assert.equal(again.pendingForecast().length, 1); assert.equal(again.pending().length, 1); again.close();
});
test('feed API requests retain timeout, caching, User-Agent and shared rate-limit backoff', async t => {
  const f = fixture(t); let calls = 0, limited = false;
  const api = new CodexApi('Kodded/test', async (url, options) => {
    calls++; assert.equal(options.headers['User-Agent'], 'Kodded/test'); assert.ok(options.signal);
    assert.match(url, /\/api\/(feed|forecast)$/);
    return { ok: !limited, status: limited ? 429 : 200, headers: { get: () => '300' }, json: async () => f.feed([]) };
  }, f.now);
  await Promise.all([api.get('feed'), api.get('feed')]); await api.get('feed'); assert.equal(calls, 1);
  f.tick(); limited = true; await assert.rejects(api.get('feed'), /rate limited/);
  await assert.rejects(api.get('forecast'), /rate limited/); assert.equal(calls, 2);
  f.tick(300000); limited = false; await api.get('feed'); assert.equal(calls, 3);
  const failed = new CodexApi('Kodded/test', async () => { throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(failed.get('feed'), /Timed out/); assert.equal(failed.inflight.size, 0);
});
function interaction(sub, manage) {
  return { replies: [], commandName: 'kodded', guildId: A, isChatInputCommand: () => true, inGuild: () => true,
    options: { getSubcommand: () => sub, getSubcommandGroup: () => 'tibo' },
    memberPermissions: { has: bit => manage && bit === PermissionFlagsBits.ManageGuild },
    deferReply: async function(payload) { assert.equal(payload.flags, MessageFlags.Ephemeral); this.deferred = true; },
    editReply: async function(payload) { this.replies.push(payload); } };
}
test('Tibo commands enforce Manage Server and ephemeral replies; informational config is available to members', async t => {
  const f = fixture(t); f.store.setup(A, C); const client = discord(), handlers = {};
  client.on = (event, fn) => { handlers[event] = fn; }; client.once = () => {};
  installCommands(client, f.store, { get: async endpoint => { assert.equal(endpoint, 'feed'); return f.feed([f.post(1)]); } });
  const run = handlers[Events.InteractionCreate];
  for (const sub of ['enable', 'disable']) { const i = interaction(sub, false); await run(i); assert.match(i.replies[0].content, /Manage Server/); }
  const config = interaction('config', false); await run(config); assert.match(config.replies[0].content, /Disabled/);
  await run(interaction('enable', true)); assert.equal(f.store.getGuild(A).tibo_notifications_enabled, 1); assert.equal(f.store.pendingTibo().length, 0);
  await run(interaction('disable', true)); assert.equal(f.store.getGuild(A).tibo_notifications_enabled, 0); assert.equal(f.store.getGuild(A).notifications_enabled, 1);
  f.store.removeGuild(A); const missing = interaction('enable', true); await run(missing); assert.match(missing.replies[0].content, /kodded setup/);
});
test('feed failure never blocks existing monitoring, and Tibo content never confirms a reset', async t => {
  const f = fixture(t); f.store.observeTibo(f.feed([])); f.enable(); let calls = []; let feedFails = true;
  const forecast = { last_reset_at: '2026-10-15T07:00:00Z', updated_at: new Date(f.now()).toISOString(), probabilities: { rounded_24h: 30, rounded_48h: 45 } };
  const client = discord();
  const api = { get: async endpoint => { calls.push(endpoint); if (endpoint === 'forecast') return forecast; if (feedFails) throw new Error('Feed timeout'); return f.feed([f.post(1, { text: 'Reset will happen tomorrow' })]); } };
  const monitor = createMonitor(client, f.store, api); await monitor(); assert.equal(client.sent.length, 0);
  feedFails = false; f.tick(); await monitor(); assert.equal(client.sent.length, 1); assert.equal(client.sent[0].embed.title, 'New Tibo Post');
  assert.equal(f.store.latest(), '2026-10-15T07:00:00.000Z'); assert.equal(f.store.pending().length, 0);
  assert.deepEqual(calls, ['forecast', 'feed', 'forecast', 'feed']);
});
test('enabling a second guild silently baselines the refreshed feed while the first guild keeps its new deliveries', t => {
  const f = fixture(t); f.store.observeTibo(f.feed([f.post(1)])); f.enable(); f.store.setup(B, C);
  f.tick(); f.store.observeTibo(f.feed([f.post(2)])); f.store.enableTibo(B, true);
  assert.deepEqual(f.store.pendingTibo().map(d => d.guild_id), [A]);
  f.tick(); f.store.observeTibo(f.feed([f.post(3)]));
  assert.deepEqual(f.store.pendingTibo().map(d => d.guild_id), [A, A, B]);
});
test('disabling during channel lookup cancels sends and never acknowledges an undelivered post', async t => {
  const f = fixture(t); f.store.observeTibo(f.feed([])); f.enable(); f.tick(); f.store.observeTibo(f.feed([f.post(1)]));
  const client = discord(), fetchGuild = client.guilds.fetch;
  client.guilds.fetch = async id => { const guild = await fetchGuild(id); f.store.enableTibo(A, false); return guild; };
  await deliverTiboPending(client, f.store);
  assert.equal(client.sent.length, 0); assert.equal(f.store.tiboState(A).last_notified_post, null);
});
