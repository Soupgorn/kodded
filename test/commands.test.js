const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Events, MessageFlags } = require('discord.js');
const { installCommands } = require('../commands');
function client(fails = false) {
  const handlers = {}, operations = [];
  const manager = scope => ({
    create: async json => { operations.push(['create', json]); if (fails) throw new Error('Registration unavailable'); },
    fetch: async () => { operations.push(['fetch', scope]); return new Map([
      ['old', { id: 'old', name: 'codex', type: 1 }],
      ['context', { id: 'context', name: 'codex', type: 2 }],
      ['other', { id: 'other', name: 'unrelated', type: 1 }]
    ]); },
    delete: async id => { operations.push(['delete', scope, id]); }
  });
  const guild = { id: 'guild', commands: manager('guild') };
  const c = { handlers, operations, guild, application: { commands: manager('global') }, guilds: { cache: new Map([['guild', guild]]) },
    once: (event, fn) => { handlers[event] = fn; }, on: (event, fn) => { handlers[event] = fn; } };
  installCommands(c, {}, {}); return c;
}
test('/kodded registers globally before targeted global and guild /codex removal, retaining every subcommand', async () => {
  const c = client(); await c.handlers[Events.GuildCreate](c.guild); assert.equal(c.operations.length, 0);
  await c.handlers[Events.ClientReady]();
  assert.equal(c.operations[0][0], 'create'); const command = c.operations[0][1];
  assert.equal(command.name, 'kodded'); assert.equal(command.default_member_permissions, undefined);
  assert.deepEqual(command.contexts, [0]);
  assert.deepEqual(command.options.map(option => option.name), ['status', 'forecast', 'history', 'setup', 'config', 'notify', 'forecast-alert', 'tibo']);
  assert.deepEqual(c.operations.filter(([op]) => op === 'delete'), [['delete', 'global', 'old'], ['delete', 'guild', 'old']]);
  await c.handlers[Events.GuildCreate]({ ...c.guild, id: 'new-guild' });
  assert.equal(c.operations.filter(([op]) => op === 'delete').length, 3);
});
test('registration failure never fetches or deletes old commands, including on guild join', async () => {
  const c = client(true); await c.handlers[Events.ClientReady](); await c.handlers[Events.GuildCreate](c.guild);
  assert.deepEqual(c.operations.map(([op]) => op), ['create']);
});
test('global cleanup failure leaves unrelated commands intact and does not block guild cleanup', async () => {
  const c = client(); c.application.commands.delete = async () => { throw new Error('Forbidden'); };
  await c.handlers[Events.ClientReady]();
  assert.deepEqual(c.operations.filter(([op]) => op === 'delete'), [['delete', 'guild', 'old']]);
});
test('cached /codex invocations receive an ephemeral redirect and do not change configuration', async () => {
  const c = client(); const replies = [];
  await c.handlers[Events.InteractionCreate]({ commandName: 'codex', isChatInputCommand: () => true,
    deferReply: async options => assert.equal(options.flags, MessageFlags.Ephemeral), editReply: async payload => replies.push(payload) });
  assert.match(replies[0].content, /moved to \/kodded/); assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});
