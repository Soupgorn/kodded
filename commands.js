const {
  Events,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags
} = require("discord.js");

const fs = require("node:fs/promises");

const API = "https://codex-reset.com/api";
const SOURCE = "[codex-reset.com](https://codex-reset.com/)";

const cache = new Map();

async function fetchApi(endpoint) {
  const cached = cache.get(endpoint);

  if (cached && Date.now() - cached.time < 90_000) {
    return cached.data;
  }

  const response = await fetch(`${API}/${endpoint}`, {
    headers: {
      "User-Agent": process.env.CODEX_USER_AGENT
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }

  const data = await response.json();

  cache.set(endpoint, {
    time: Date.now(),
    data
  });

  return data;
}

function formatTime(date) {
  const time = Date.parse(date);

  if (!Number.isFinite(time)) return "Unknown";

  return `<t:${Math.floor(time / 1000)}:F>`;
}

module.exports = (client) => {
  const command = new SlashCommandBuilder()
    .setName("codex")
    .setDescription("Codex global reset information")

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

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(
        process.env.DISCORD_GUILD_ID
      );

      await guild.commands.create(command.toJSON());

      console.log("Kodded slash commands registered!");
    } catch (error) {
      console.error("Command registration failed:", error);
    }
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "codex") return;

    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const sub = interaction.options.getSubcommand();

      const embed = new EmbedBuilder()
        .setColor(0xffffff)
        .setFooter({ text: "Kodded • Reset Monitor v1.1" })
        .setTimestamp();

      if (sub === "status") {
        const state = JSON.parse(
          await fs.readFile("/app/data/state.json", "utf8")
        );

        embed
          .setTitle("Codex Reset Status")
          .addFields(
            {
              name: "Last Reset",
              value: formatTime(state.lastResetAt)
            },
            {
              name: "Monitoring",
              value: "🟢 Active • Every 2 minutes"
            }
          );
      }

      if (sub === "forecast") {
        const data = await fetchApi("forecast");

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
        const data = await fetchApi("timeline");

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
      console.error("Command error:", error);

      const message = "Unable to retrieve Codex data.";

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: message });
        } else {
          await interaction.reply({
            content: message,
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (replyError) {
        console.error("Reply failed:", replyError);
      }
    }
  });
};
