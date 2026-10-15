const { Client, GatewayIntentBits, Events } = require("discord.js");
const fs = require("node:fs/promises");

const API = "https://codex-reset.com/api/forecast";
const STATE_FILE = "/app/data/state.json";
const CHECK_INTERVAL = 120_000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let lastResetAt = null;
let checking = false;
let retryAfter = 0;

for (const name of [
  "DISCORD_TOKEN",
  "DISCORD_CHANNEL_ID",
  "CODEX_USER_AGENT"
]) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

async function saveState(value) {
  const temp = `${STATE_FILE}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify({ lastResetAt: value })
  );

  await fs.rename(temp, STATE_FILE);
  lastResetAt = value;
}

async function getChannel() {
  const channel = await client.channels.fetch(
    process.env.DISCORD_CHANNEL_ID
  );

  if (!channel?.isTextBased() || !channel.send) {
    throw new Error("Invalid notification channel");
  }

  return channel;
}

async function checkReset() {
  if (checking || Date.now() < retryAfter) return;
  checking = true;

  try {
    const response = await fetch(API, {
      headers: {
        "User-Agent": process.env.CODEX_USER_AGENT
      },
      signal: AbortSignal.timeout(15000)
    });

    if (response.status === 429) {
      const seconds = Number(
        response.headers.get("retry-after")
      );

      retryAfter = Date.now() +
        Math.max(
          120000,
          (Number.isFinite(seconds) ? seconds : 120) * 1000
        );

      throw new Error("API rate limited");
    }

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const current = data.last_reset_at;

    if (!current || !Number.isFinite(Date.parse(current))) {
      throw new Error("Invalid reset timestamp");
    }

    // First launch: remember the current reset.
    if (lastResetAt === null) {
      await saveState(current);
      console.log("Baseline reset:", current);
      return;
    }

    if (Date.parse(current) <= Date.parse(lastResetAt)) {
      return;
    }

    const channel = await getChannel();
    const timestamp = Math.floor(Date.parse(current) / 1000);

    await channel.send({
      content:
        "✅ **Codex Global Reset Confirmed!**\n" +
        `🕒 Reset Time: <t:${timestamp}:F>\n` +
        "Data: https://codex-reset.com/"
    });

    await saveState(current);
    console.log("New reset notification sent:", current);

  } catch (error) {
    console.error("Reset check failed:", error.message);
  } finally {
    checking = false;
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Kodded online as ${client.user.tag}`);

  try {
    const state = JSON.parse(
      await fs.readFile(STATE_FILE, "utf8")
    );
    lastResetAt = state.lastResetAt ?? null;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("State load failed:", error.message);
      process.exit(1);
    }
  }

  if (process.env.SEND_STARTUP_TEST === "true") {
    try {
      const channel = await getChannel();
      await channel.send(
        "🟢 **Kodded is online!**\n" +
        "Codex Reset monitoring has started."
      );
    } catch (error) {
      console.error("Startup test failed:", error.message);
    }
  }

  await checkReset();
  setInterval(checkReset, CHECK_INTERVAL);
});

require("./commands")(client);
client.login(process.env.DISCORD_TOKEN);
