const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const log = require('../log');
const { validId } = require('../database');
async function validateChannel(guild, channel) {
  if (!channel || !validId(channel.id) || channel.guildId !== guild.id ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Choose a text or announcement channel in this server.');
  }
  const member = guild.members.me ?? await guild.members.fetchMe();
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new Error('Kodded needs View Channel, Send Messages and Embed Links in that channel.');
  }
  return channel;
}
async function deliverPending(client, store) {
  for (const delivery of store.pending()) {
    const { guild_id, channel_id, reset_at } = delivery;
    // Recheck after asynchronous deliveries in case an administrator disables notifications.
    const config = store.getGuild(guild_id);
    if (!config?.notifications_enabled || config.channel_id !== channel_id) continue;
    try {
      const guild = await client.guilds.fetch(guild_id);
      const channel = await validateChannel(guild, await guild.channels.fetch(channel_id));
      const current = store.getGuild(guild_id);
      if (!current?.notifications_enabled || current.channel_id !== channel_id) continue;
      await channel.send({ embeds: [new EmbedBuilder().setColor(0x57f287)
        .setTitle('Codex Global Reset Confirmed!')
        .setDescription(`Reset Time: <t:${Math.floor(Date.parse(reset_at) / 1000)}:F>\nData: [codex-reset.com](https://codex-reset.com/)`)],
      allowedMentions: { parse: [] } });
      store.delivered(guild_id, reset_at, channel_id);
      log('notification_sent', { guild_id, reset_at });
    } catch (error) { log('notification_failed', { guild_id, code: error.code, message: error.message }); }
  }
}
async function sendStartupTest(client, store) {
  for (const config of store.db.prepare('SELECT * FROM guild_config WHERE notifications_enabled=1').all()) {
    try {
      const guild = await client.guilds.fetch(config.guild_id);
      const channel = await validateChannel(guild, await guild.channels.fetch(config.channel_id));
      await channel.send({ content: '🟢 **Kodded is online!**\nCodex Reset monitoring has started.', allowedMentions: { parse: [] } });
    } catch (error) { log('startup_test_failed', { guild_id: config.guild_id, message: error.message }); }
  }
}
module.exports = { validateChannel, deliverPending, sendStartupTest };
