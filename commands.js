const { Events, SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits,
  ChannelType, InteractionContextType, ApplicationIntegrationType } = require('discord.js');
const { validateChannel } = require('./src/services/notification-service');
const log = require('./src/log');
const SOURCE = '[codex-reset.com](https://codex-reset.com/)';
function formatTime(date) {
  const time = Date.parse(date);

  if (!Number.isFinite(time)) return "Unknown";

  return `<t:${Math.floor(time / 1000)}:F>`;
}

function installCommands(client, store, api) {
  const command = new SlashCommandBuilder()
    .setName("kodded")
    .setDescription("Codex global reset information")
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)

    .addSubcommand(sub =>
      sub.setName("status")
        .setDescription("View the latest reset")
    )

    .addSubcommand(sub =>
      sub.setName("forecast")
        .setDescription("View reset predictions")
    )

    .addSubcommand(sub =>
      sub.setName("history")
        .setDescription("View confirmed reset history")
    );

  command.addSubcommand(sub => sub.setName('setup').setDescription('Set this server notification channel')
    .addChannelOption(option => option.setName('channel').setDescription('Notification channel').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(sub => sub.setName('config').setDescription('View this server notification configuration'))
    .addSubcommandGroup(group => group.setName('notify').setDescription('Manage notifications')
      .addSubcommand(sub => sub.setName('enable').setDescription('Enable notifications'))
      .addSubcommand(sub => sub.setName('disable').setDescription('Disable notifications')))
    .addSubcommandGroup(group => group.setName('forecast-alert').setDescription('Manage forecast probability alerts')
      .addSubcommand(sub => sub.setName('enable').setDescription('Enable forecast alerts'))
      .addSubcommand(sub => sub.setName('disable').setDescription('Disable forecast alerts'))
      .addSubcommand(sub => sub.setName('config').setDescription('View forecast alert settings')))
    .addSubcommandGroup(group => group.setName('tibo').setDescription('Manage Tibo post notifications')
      .addSubcommand(sub => sub.setName('enable').setDescription('Enable future Tibo feed posts'))
      .addSubcommand(sub => sub.setName('disable').setDescription('Disable Tibo post notifications'))
      .addSubcommand(sub => sub.setName('config').setDescription('View Tibo notification settings')));

  let globalRegistered = false;
  async function removeDeprecated(manager, scope) {
    if (!globalRegistered) return;
    try {
      const commands = await manager.fetch();
      for (const old of commands.values()) {
        if (old.name !== 'codex' || old.type !== 1) continue;
        try { await manager.delete(old.id); }
        catch (error) { log('deprecated_command_delete_failed', { scope, command_id: old.id, message: error.message }); }
      }
    } catch (error) { log('command_cleanup_failed', { scope, message: error.message }); }
  }
  const cleanGuild = guild => removeDeprecated(guild.commands, guild.id);
  client.once(Events.ClientReady, async () => {
    try {
      // Name-based upsert preserves unrelated commands. Never remove /codex until this succeeds.
      await client.application.commands.create(command.toJSON());
      globalRegistered = true;
      await removeDeprecated(client.application.commands, 'global');
      for (const guild of client.guilds.cache.values()) await cleanGuild(guild);
      log('commands_registered');
    } catch (error) { log('command_registration_failed', { message: error.message }); }
  });
  client.on(Events.GuildCreate, cleanGuild);

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!["kodded", "codex"].includes(interaction.commandName)) return;

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      if (interaction.commandName === 'codex') {
        await interaction.editReply({ content: 'This command has moved to /kodded. Please use /kodded with the same subcommand.', allowedMentions: { parse: [] } });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (!interaction.inGuild()) throw new Error('Use /kodded in a Discord server.');
      const group = interaction.options.getSubcommandGroup(false);
      if (group === 'tibo') {
        const config = store.getGuild(interaction.guildId);
        if (sub === 'config') {
          const state = store.tiboState(interaction.guildId);
          await interaction.editReply({ content:
            `Tibo post notifications: ${config?.tibo_notifications_enabled ? 'Enabled' : 'Disabled'}\n` +
            `Channel: ${config ? `<#${config.channel_id}>` : 'Not configured; run /kodded setup first.'}\n` +
            `Last successfully delivered post: ${state?.last_notified_post ?? 'None recorded'}\n` +
            'Checks approximately every two minutes. Covers posts and replies ingested by codex-reset.com, not every X post. A post is not confirmation of a reset.',
            allowedMentions: { parse: [] } });
          return;
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          throw new Error('You need Manage Server permission to change notification settings.');
        }
        if (!config) throw new Error('Configure a channel with /kodded setup first.');
        if (sub === 'enable' && !config.tibo_notifications_enabled) {
          const guild = interaction.guild ?? await client.guilds.fetch(interaction.guildId);
          await validateChannel(guild, await guild.channels.fetch(config.channel_id));
          store.observeTibo(await api.get('feed', { fresh: true }));
        }
        store.enableTibo(interaction.guildId, sub === 'enable');
        await interaction.editReply({ content: `Tibo post notifications ${sub === 'enable' ? 'enabled for future feed entries' : 'disabled'}. Reset and forecast settings are independent.`, allowedMentions: { parse: [] } });
        return;
      }
      if (group === 'forecast-alert') {
        const config = store.getGuild(interaction.guildId);
        const policy = store.forecastPolicy;
        if (sub === 'config') {
          const state = store.forecastState(interaction.guildId);
          const until = state?.last_notified_at == null ? null : state.last_notified_at + policy.cooldownMs;
          await interaction.editReply({ content:
            `Forecast alerts: ${config?.forecast_alerts_enabled ? 'Enabled' : 'Disabled'}\n` +
            `Channel: ${config ? `<#${config.channel_id}>` : 'Not configured; run /kodded setup first.'}\n` +
            `24h: at least ${policy.min24}% and +${policy.increase24} percentage points\n` +
            `48h: at least ${policy.min48}% and +${policy.increase48} percentage points\n` +
            `Cooldown: ${policy.cooldownMs / 3600000} hours per server after a successful alert\n` +
            `Last successful alert: ${state?.last_notified_at == null ? 'None recorded' : formatTime(new Date(state.last_notified_at).toISOString())}\n` +
            `Next eligible time: ${until == null ? 'No previous cooldown' : formatTime(new Date(until).toISOString())}\n` +
            'This is a forecast, not a confirmed reset.', allowedMentions: { parse: [] } });
          return;
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          throw new Error('You need Manage Server permission to change notification settings.');
        }
        if (!config) throw new Error('Configure a channel with /kodded setup first.');
        if (sub === 'enable' && !config.forecast_alerts_enabled) {
          const guild = interaction.guild ?? await client.guilds.fetch(interaction.guildId);
          await validateChannel(guild, await guild.channels.fetch(config.channel_id));
          const data = await api.get('forecast', { fresh: true });
          store.observe(data.last_reset_at);
          store.observeForecast(data);
        }
        store.enableForecast(interaction.guildId, sub === 'enable');
        await interaction.editReply({ content: `Forecast alerts ${sub === 'enable' ? 'enabled for future probability increases' : 'disabled'}. Confirmed reset settings are independent.`, allowedMentions: { parse: [] } });
        return;
      }
      if (sub === 'setup' || group === 'notify') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          throw new Error('You need Manage Server permission to change notification settings.');
        }
        if (sub === 'setup') {
          const selected = interaction.options.getChannel('channel', true);
          const guild = interaction.guild ?? await client.guilds.fetch(interaction.guildId);
          const channel = await validateChannel(guild, await guild.channels.fetch(selected.id));
          // Refresh the shared cached forecast before first setup, so old observations cannot replay.
          if (!store.getGuild(interaction.guildId)) store.observe((await api.get('forecast', { fresh: true })).last_reset_at);
          store.setup(interaction.guildId, channel.id);
          await interaction.editReply({ content: `Notifications configured for <#${channel.id}>.`, allowedMentions: { parse: [] } });
        } else {
          if (sub === 'enable' && !store.getGuild(interaction.guildId)?.notifications_enabled) {
            if (!store.getGuild(interaction.guildId)) throw new Error('Configure a channel with /kodded setup first.');
            store.observe((await api.get('forecast', { fresh: true })).last_reset_at);
          }
          store.enable(interaction.guildId, sub === 'enable');
          await interaction.editReply({ content: `Notifications ${sub === 'enable' ? 'enabled' : 'disabled'}.` });
        }
        return;
      }
      if (sub === 'config') {
        const config = store.getGuild(interaction.guildId);
        await interaction.editReply({ content: config
          ? `Channel: <#${config.channel_id}>\nConfirmed reset notifications: ${config.notifications_enabled ? 'Enabled' : 'Disabled'}\nForecast alerts: ${config.forecast_alerts_enabled ? 'Enabled' : 'Disabled'}\nTibo post notifications: ${config.tibo_notifications_enabled ? 'Enabled' : 'Disabled'}\nLast successfully notified reset: ${config.last_notified_reset ? formatTime(config.last_notified_reset) : 'None recorded'}`
          : 'No notification channel configured. Ask a server manager to run /kodded setup.', allowedMentions: { parse: [] } });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xffffff)
        .setFooter({ text: "Kodded • Reset Monitor" })
        .setTimestamp();

      if (sub === "status") {
        embed
          .setTitle("Codex Reset Status")
          .addFields(
            {
              name: "Last Reset",
              value: formatTime(store.latest())
            },
            {
              name: "Monitoring",
              value: "🟢 Active • Every 2 minutes"
            }
          );
      }

      if (sub === "forecast") {
        const data = await api.get("forecast");

        embed
          .setTitle("Codex Reset Forecast")
          .setDescription(
            "Estimated global reset probability.\n" +
            "These are predictions, not guarantees."
          )
          .addFields(
            {
              name: "Next 24 Hours",
              value: `${data.probabilities.rounded_24h}%`,
              inline: true
            },
            {
              name: "Next 48 Hours",
              value: `${data.probabilities.rounded_48h}%`,
              inline: true
            },
            {
              name: "Confidence",
              value: String(data.confidence ?? "Unknown")
            },
            {
              name: "Last Reset",
              value: formatTime(data.last_reset_at)
            },
            {
              name: "Updated",
              value: formatTime(data.updated_at)
            }
          );
      }

      if (sub === "history") {
        const data = await api.get("timeline");

        const events = data.events
          .filter(event =>
            event.group === "reset" &&
            event.announcement_state === "announced"
          )
          .slice(0, 3);

        embed
          .setTitle("Codex Reset History")
          .setDescription("Latest confirmed global resets");

        if (!events.length) {
          embed.addFields({
            name: "History",
            value: "No confirmed resets found."
          });
        }

        for (const [index, event] of events.entries()) {
          const url = typeof event.url === "string"
            && /^https:\/\//.test(event.url)
            ? `\n[View announcement](${event.url})`
            : "";

          embed.addFields({
            name: `Reset #${index + 1}`,
            value:
              `${formatTime(event.announced_at)}\n` +
              `${String(event.summary ?? "").slice(0, 200)}` +
              url
          });
        }
      }

      embed.addFields({
        name: "Data Source",
        value: SOURCE
      });

      await interaction.editReply({
        embeds: [embed],
        allowedMentions: { parse: [] }
      });

    } catch (error) {
      log("command_failed", { message: error.message });

      const message = error.message.startsWith("Codex API") ? "Unable to retrieve Codex data; please try again later." : error.message;

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
        } else {
          await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (replyError) {
        log("reply_failed", { message: replyError.message });
      }
    }
  });
};

module.exports = { installCommands };
