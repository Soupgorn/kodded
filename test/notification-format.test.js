const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { openDatabase } = require('../src/database');
const { parsePost, safePostText } = require('../src/services/tibo-feed');
const { deliverPending, deliverForecastPending, deliverTiboPending, sendStartupTest, tiboEmbed } = require('../src/services/notification-service');
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';
const R1 = '444444444444444444', R2 = '555555555555555555';
const RESET1 = '2026-10-19T00:00:00.000Z', RESET2 = '2026-10-20T00:00:00.000Z';
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
function role(id, guild = A, extra = {}) { return { id, name: 'Codex-noti', mentionable: true, guild: { id: guild }, ...extra }; }
function fixture(t, configs = [{ id: A, roles: [role(R1)] }]) {
  const dir = mkdtempSync(join(tmpdir(), 'kodded-format-')), path = join(dir, 'test.sqlite');
  const options = { now: () => NOW }; let store = openDatabase(path, options);
  const sent = [], roleLookups = [];
  store.observe(RESET1);
  for (const config of configs) store.setup(config.id, C);
  const client = { guilds: { fetch: async id => {
    const config = configs.find(guild => guild.id === id);
    const guild = { id, members: { me: {} }, roles: { fetch: async () => {
      roleLookups.push(id); if (config.roleError) throw Object.assign(new Error('Forbidden'), { code: 50013 });
      return new Map((config.roles ?? []).map((r, index) => [index, r]));
    } } };
    guild.channels = { fetch: async () => ({ id: C, guildId: id, type: ChannelType.GuildText,
      permissionsFor: () => ({ has: permission => Array.isArray(permission) || (permission === PermissionFlagsBits.MentionEveryone && config.broadMention === true) }),
      send: async payload => { if (config.failSend) throw new Error('Network failure'); sent.push({ guild: id, payload }); }
    }) };
    return guild;
  } } };
  t.after(() => { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, sent, client, roleLookups, restart: () => { store.close(); store = openDatabase(path, options); } };
}
function noMentions(payload) {
  assert.equal(payload.content, undefined);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
}
test('confirmed reset resolves the actual role independently per guild and permits only that role', async t => {
  const f = fixture(t, [{ id: A, roles: [role(R1), role(R2, A, { name: 'Unrelated' })] },
    { id: B, roles: [role(R2, B), role(R1, B, { name: 'codex-noti' })] }]);
  f.store.observe(RESET2); await deliverPending(f.client, f.store);
  assert.deepEqual(f.roleLookups, [A, B]); assert.equal(f.sent.length, 2);
  for (const [index, id] of [R1, R2].entries()) {
    const payload = f.sent[index].payload;
    assert.equal(payload.content, `<@&${id}>`);
    assert.deepEqual(payload.allowedMentions, { parse: [], roles: [id], users: [], repliedUser: false });
    assert.equal(payload.embeds[0].toJSON().title, 'Codex Global Reset Confirmed!');
    assert.ok(!JSON.stringify(payload).includes('@everyone')); assert.ok(!JSON.stringify(payload).includes('@here'));
  }
  assert.equal(f.store.pending().length, 0);
});
for (const [name, config, reason] of [
  ['missing role', { roles: [] }, 'missing_role'],
  ['case-mismatched role', { roles: [role(R1, A, { name: 'codex-noti' })] }, 'missing_role'],
  ['duplicate names', { roles: [role(R1), role(R2)] }, 'duplicate_role_name'],
  ['non-mentionable role', { roles: [role(R1, A, { mentionable: false })] }, 'role_not_mentionable'],
  ['role from another guild', { roles: [role(R1, B)] }, 'invalid_role'],
  ['invalid role ID', { roles: [role('invalid')] }, 'invalid_role'],
  ['everyone role ID', { roles: [role(A)] }, 'invalid_role'],
  ['role lookup permission error', { roleError: true }, 'role_lookup_failed']
]) test(`${name}: send and acknowledge reset without ping, with a warning`, async t => {
  const logs = []; t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  const f = fixture(t, [{ id: A, ...config }]); f.store.observe(RESET2); await deliverPending(f.client, f.store);
  assert.equal(f.sent.length, 1); noMentions(f.sent[0].payload); assert.equal(f.store.pending().length, 0);
  assert.ok(logs.some(entry => entry.event === 'reset_role_mention_skipped' && entry.level === 'warn' && entry.guild_id === A && entry.reason === reason));
});
test('existing mention permission can notify a non-mentionable role while still allowing only its ID', async t => {
  const f = fixture(t, [{ id: A, roles: [role(R1, A, { mentionable: false })], broadMention: true }]);
  f.store.observe(RESET2); await deliverPending(f.client, f.store);
  assert.equal(f.sent[0].payload.content, `<@&${R1}>`);
  assert.deepEqual(f.sent[0].payload.allowedMentions.roles, [R1]);
  assert.deepEqual(f.sent[0].payload.allowedMentions.parse, []);
});
test('confirmed reset role pings remain deduplicated across repeated observations and SQLite restart', async t => {
  const f = fixture(t); f.store.observe(RESET2); await deliverPending(f.client, f.store);
  f.restart(); f.store.observe(RESET2); await deliverPending(f.client, f.store);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.roleLookups, [A]);
  assert.equal(f.store.getGuild(A).last_notified_reset, RESET2);
});
test('a failed guild retries without repeating another guild role ping', async t => {
  const configs = [{ id: A, roles: [role(R1)] }, { id: B, roles: [role(R2, B)], failSend: true }];
  const f = fixture(t, configs); f.store.observe(RESET2); await deliverPending(f.client, f.store);
  assert.equal(f.sent.length, 1); configs[1].failSend = false; f.restart(); await deliverPending(f.client, f.store);
  assert.deepEqual(f.sent.map(message => message.guild), [A, B]);
  assert.deepEqual(f.roleLookups, [A, B, B]);
});
test('forecast, Tibo and startup sends suppress all mentions without resolving the role', async t => {
  const f = fixture(t);
  const forecast = { last_reset_at: RESET1, updated_at: new Date(NOW - 120000).toISOString(), probabilities: { rounded_24h: 30, rounded_48h: 45 } };
  f.store.observeForecast(forecast); f.store.enableForecast(A, true);
  f.store.observeForecast({ ...forecast, updated_at: new Date(NOW).toISOString(), probabilities: { rounded_24h: 45, rounded_48h: 60 } });
  f.store.observeTibo({ stale: false, fetched_at: new Date(NOW).toISOString(), tweets: [] }); f.store.enableTibo(A, true);
  f.store.observeTibo({ stale: false, fetched_at: new Date(NOW).toISOString(), tweets: [{ id: '2110000000000000001', at: new Date(NOW - 60000).toISOString(),
    text: `@everyone @here <@&${R1}> <@${R2}>`, url: 'https://x.com/thsottiaux/status/2110000000000000001' }] });
  await deliverForecastPending(f.client, f.store); await deliverTiboPending(f.client, f.store); await sendStartupTest(f.client, f.store);
  assert.equal(f.sent.length, 3); assert.deepEqual(f.roleLookups, []);
  for (const { payload } of f.sent) {
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.ok(!JSON.stringify(payload).includes('@everyone')); assert.ok(!JSON.stringify(payload).includes('@here'));
    assert.ok(!JSON.stringify(payload).includes('<@&'));
  }
});
test('Tibo embed contains exactly the requested fields with complete ordinary API text and original URL', () => {
  const text = "Day 15/ Nevermind, we're still cooking... and reset. Enjoy. https://t.co/RZ9WhtI802";
  const url = 'https://x.com/thsottiaux/status/2110000000000000001';
  const post = parsePost({ id: '2110000000000000001', at: RESET2, text, url }, NOW);
  assert.equal(post.text, text);
  assert.deepEqual(tiboEmbed(post).toJSON(), { color: 0xffffff, title: 'New Tibo Post', fields: [
    { name: 'Post content', value: text }, { name: 'Original post', value: `[View on X](${url})` }
  ] });
  assert.equal(parsePost({ ...post, id: post.post_id, at: RESET2, url: 'https://evil.example/post' }, NOW), null);
});
test('ordinary text at the field limit stays complete; longer Unicode content stays within the limit', () => {
  const text = 'Sentence. '.repeat(102) + 'Done'; assert.equal(text.length, 1024);
  assert.equal(safePostText(text), text);
  assert.equal(safePostText('- List item\n1. Numbered item'), '\\- List item\n1\\. Numbered item');
  assert.equal(safePostText('  Original text.\nSecond line!  '), '  Original text.\nSecond line!  ');
  const longer = safePostText('😀'.repeat(800)); assert.ok(longer.length <= 1024); assert.ok(longer.endsWith('…'));
  assert.ok(!/[\ud800-\udbff]…$/.test(longer));
});
