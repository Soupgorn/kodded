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
function forecastEmbed(delivery) {
  const movement = (baseline, current) => `${baseline}% → ${current}% (${current - baseline >= 0 ? '+' : ''}${Number((current - baseline).toFixed(2))} pp)`;
  return new EmbedBuilder().setColor(0xf5b942)
    .setTitle('Codex Reset Probability Rising!')
    .setDescription('The estimated probability of a global Codex reset has increased.\n\nThis is a forecast, not a confirmed reset.')
    .addFields(
      { name: 'Next 24 Hours', value: movement(delivery.baseline_24h, delivery.p24), inline: true },
      { name: 'Next 48 Hours', value: movement(delivery.baseline_48h, delivery.p48), inline: true },
      { name: 'Confidence', value: delivery.confidence.charAt(0).toUpperCase() + delivery.confidence.slice(1) },
      { name: 'Updated', value: `<t:${Math.floor(Date.parse(delivery.snapshot_at) / 1000)}:F>` },
      { name: 'Data Source', value: '[codex-reset.com](https://codex-reset.com/)' })
    .setFooter({ text: 'Kodded • Forecast Alert' });
}
async function deliverForecastPending(client, store) {
  for (const delivery of store.pendingForecast()) {
    if (!store.forecastDeliveryCurrent(delivery)) continue;
    try {
      const guild = await client.guilds.fetch(delivery.guild_id);
      const channel = await validateChannel(guild, await guild.channels.fetch(delivery.channel_id));
      if (!store.forecastDeliveryCurrent(delivery)) continue;
      await channel.send({ embeds: [forecastEmbed(delivery)], allowedMentions: { parse: [] } });
      store.deliveredForecast(delivery);
      log('forecast_notification_sent', { guild_id: delivery.guild_id, snapshot_at: delivery.snapshot_at });
    } catch (error) { log('forecast_notification_failed', { guild_id: delivery.guild_id, code: error.code, message: error.message }); }
  }
}
function tiboEmbed(post) {
  return new EmbedBuilder().setColor(0xffffff).setTitle('New Tibo Post')
    .addFields(
      { name: 'Author', value: 'Tibo (@thsottiaux)' },
      { name: 'Post content', value: post.text },
      { name: 'Published', value: `<t:${Math.floor(Date.parse(post.published_at) / 1000)}:F>` },
      { name: 'Original post', value: `[View on X](${post.url})` },
      { name: 'Data', value: 'https://codex-reset.com/' })
    .setFooter({ text: 'Kodded • Tibo Post Monitor' });
}
async function deliverTiboPending(client, store) {
  const failedGuilds = new Set();
  for (const delivery of store.pendingTibo()) {
    if (failedGuilds.has(delivery.guild_id) || !store.tiboDeliveryCurrent(delivery)) continue;
    try {
      const guild = await client.guilds.fetch(delivery.guild_id);
      const channel = await validateChannel(guild, await guild.channels.fetch(delivery.channel_id));
      if (!store.tiboDeliveryCurrent(delivery)) continue;
      await channel.send({ embeds: [tiboEmbed(delivery)], allowedMentions: { parse: [] } });
      store.deliveredTibo(delivery);
      log('tibo_notification_sent', { guild_id: delivery.guild_id, post_id: delivery.post_id });
    } catch (error) {
      // Preserve chronological delivery for this guild; continue serving other guilds.
      failedGuilds.add(delivery.guild_id);
      log('tibo_notification_failed', { guild_id: delivery.guild_id, post_id: delivery.post_id, code: error.code, message: error.message });
    }
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
module.exports = { validateChannel, deliverPending, deliverForecastPending, forecastEmbed, deliverTiboPending, tiboEmbed, sendStartupTest };
