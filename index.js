const { Client, GatewayIntentBits, Events } = require('discord.js');
const { openDatabase } = require('./src/database');
const { CodexApi } = require('./src/services/api');
const { createMonitor } = require('./src/services/reset-monitor');
const { sendStartupTest } = require('./src/services/notification-service');
const { installCommands } = require('./commands');
const log = require('./src/log');
for (const name of ['DISCORD_TOKEN', 'CODEX_USER_AGENT']) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
}
const store = openDatabase(process.env.DATABASE_PATH || '/app/data/kodded.sqlite', {
  legacyPath: '/app/data/state.json', env: process.env
});
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
const api = new CodexApi(process.env.CODEX_USER_AGENT);
const checkReset = createMonitor(client, store, api);
let timer;
let shuttingDown = false;
installCommands(client, store, api);
client.once(Events.ClientReady, async () => {
  log('ready', { user: client.user.tag });
  if (process.env.SEND_STARTUP_TEST === 'true') await sendStartupTest(client, store);
  try { await checkReset(); } catch (error) { log('monitor_failed', { message: error.message }); }
  if (!shuttingDown) timer = setInterval(() => checkReset().catch(error => log('monitor_failed', { message: error.message })), 120000);
});
client.on(Events.GuildDelete, guild => {
  // discord.js emits GuildUnavailable separately for temporary outages.
  store.removeGuild(guild.id);
  log('guild_removed', { guild_id: guild.id });
});
client.on(Events.Error, error => log('discord_error', { message: error.message }));
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  try { await checkReset.stop(); }
  finally { await client.destroy(); store.close(); }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
client.login(process.env.DISCORD_TOKEN).catch(error => {
  log('login_failed', { message: error.message }); store.close(); process.exitCode = 1;
});
