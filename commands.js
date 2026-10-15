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
    .setName("codex")
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
      .addSubcommand(sub => sub.setName('disable').setDescription('Disable notifications')));

  let globalRegistered = false;
  async function cleanGuild(guild) {
    if (!globalRegistered) return;
    try {
      const commands = await guild.commands.fetch();
      for (const old of commands.values()) {
        if (old.name === 'codex' && old.type === 1) await guild.commands.delete(old.id);
      }
    } catch (error) { log('guild_command_cleanup_failed', { guild_id: guild.id, message: error.message }); }
  }
  client.once(Events.ClientReady, async () => {
    try {
      // Name-based upsert preserves unrelated application commands.
      await client.application.commands.create(command.toJSON());
      globalRegistered = true;
      for (const guild of client.guilds.cache.values()) await cleanGuild(guild);
      log('commands_registered');
    } catch (error) { log('command_registration_failed', { message: error.message }); }
  });
  client.on(Events.GuildCreate, cleanGuild);

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "codex") return;

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const sub = interaction.options.getSubcommand();

      if (!interaction.inGuild()) throw new Error('Use /codex in a Discord server.');
      const group = interaction.options.getSubcommandGroup(false);
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
            if (!store.getGuild(interaction.guildId)) throw new Error('Configure a channel with /codex setup first.');
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
          ? `Channel: <#${config.channel_id}>\nNotifications: ${config.notifications_enabled ? 'Enabled' : 'Disabled'}\nLast successfully notified reset: ${config.last_notified_reset ? formatTime(config.last_notified_reset) : 'None recorded'}`
          : 'No notification channel configured. Ask a server manager to run /codex setup.', allowedMentions: { parse: [] } });
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
