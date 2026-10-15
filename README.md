# Kodded

Kodded monitors global Codex goodwill resets using [codex-reset.com](https://codex-reset.com/). One Node.js 24 / discord.js v14 process polls every two minutes and distributes notifications across independently configured Discord servers. No inbound ports, public IP, web server, or privileged Gateway intents are required.

## Features and architecture

- Global `/codex` commands; all command responses are ephemeral.
- Independent notification channels and enable/disable settings per server.
- Optional forecast probability increase alerts, separate from confirmed reset notifications.
- Shared API cache (90 seconds), 15-second request timeout, and shared `Retry-After` handling with a two-minute minimum backoff.
- SQLite persistence with transactions, WAL mode, and a durable per-server delivery queue.
- Embed notifications without mentions; permission/channel failures are isolated and retried.

`Codex API → shared monitor → SQLite delivery queue → configured Discord channels`

`index.js` wires the Gateway client and lifecycle. `commands.js` handles commands and registration. `src/services` contains the API client, monitor, and notification service; `src/database` owns persistence and startup migration.

The [API guide](https://codex-reset.com/developers) and [public route documentation](https://codex-reset.com/llms.txt) describe the upstream service. Kodded continues to use `forecast.last_reset_at` for reset detection, forecast probability/confidence fields, and announced reset entries from `timeline.events`. Predictions are not guarantees or an OpenAI schedule.

## Install in Discord

1. Create or select the existing application in the Discord Developer Portal. Enable **Guild Install** and keep the bot token private. No Message Content intent is needed.
2. Generate an OAuth2 installation link with `bot` and `applications.commands` scopes. Select **View Channels**, **Send Messages**, and **Embed Links**. Administrator permission for the bot is unnecessary.
3. Open the link and select a server where you can manage/install apps. To add another server, reuse the same application installation link; do not run another bot instance or create another token.
4. A server administrator or member with **Manage Server** runs `/codex setup channel:#codex-reset` in each new server.
5. Check `/codex config`. Setup enables notifications for a new server; changing an existing channel preserves its enabled/disabled state. The current reset becomes a baseline, not a new alert.

Global commands can take time to appear or refresh in Discord clients. Kodded upserts only the application’s `codex` chat command, leaving unrelated commands intact. After successful global registration it removes only guild-scoped `codex` chat commands from installed guilds. Cleanup failures are logged and retried at next startup; newly joined guilds are also cleaned. Refresh Discord if the old command shape remains cached. No blanket command overwrite is used.

## Commands

| Command | Access | Behavior |
| --- | --- | --- |
| `/codex status` | Everyone | Latest locally observed reset |
| `/codex forecast` | Everyone | Cached upstream 24/48-hour probabilities and confidence |
| `/codex history` | Everyone | Latest three announced reset events |
| `/codex config` | Everyone | Channel, notification state, last successful reset delivery |
| `/codex setup channel:#channel` | Manage Server / Administrator | Validate and save a text or announcement channel |
| `/codex notify enable` | Manage Server / Administrator | Enable confirmed reset notifications; no disabled-period replay |
| `/codex notify disable` | Manage Server / Administrator | Disable confirmed reset notifications |
| `/codex forecast-alert enable` | Manage Server / Administrator | Enable future forecast increase alerts |
| `/codex forecast-alert disable` | Manage Server / Administrator | Disable forecast alerts only |
| `/codex forecast-alert config` | Everyone | Forecast preference, thresholds, last delivery, and cooldown |

All responses, including errors, are ephemeral. Permission checks apply to changing settings, not to the entire command group. Server-level Discord application command restrictions can additionally limit access. Threads, forums, DMs, foreign-server channels, and channels lacking the bot’s three required permissions are rejected. Enabling requires an existing channel configuration.

## Automatic forecast alerts

Confirmed reset alerts report an advance in `last_reset_at` and use green embeds. Forecast alerts report estimated probability movements using amber embeds and always say **“This is a forecast, not a confirmed reset.”** They do not create confirmed reset events or acknowledge reset deliveries.

Forecast alerts default to **disabled**, including for existing guilds during upgrade. After `/codex setup`, a manager can opt in with `/codex forecast-alert enable`; use `/codex forecast-alert config` to check settings. They use the same channel, but `/codex notify` and `/codex forecast-alert` control independent preferences. All responses stay ephemeral. Enabling requires a valid channel and a fresh API snapshot and silently establishes the current probability baseline; repeating enable does not reset baselines or cooldowns.

An alert qualifies when either horizon meets both of its conditions:

| Horizon | Current probability | Increase from baseline |
| --- | --- | --- |
| Next 24 hours | At least 40% | At least 10 percentage points |
| Next 48 hours | At least 60% | At least 15 percentage points |

Each guild persists its own reference for both horizons. Small upward steps accumulate against the reference. Enqueuing a qualifying movement advances both references to the current probabilities, preventing repeated alerts for that movement. A decrease of at least the configured increase threshold below a horizon's reference lowers that reference and allows subsequent recovery alerts. Smaller oscillations do not re-arm it.

A **six-hour per-guild cooldown starts only after a successful Discord send**. Failed guilds retry independently; successful guilds are not repeatedly notified. During cooldown, upward movements accumulate against the reference; a new, changed, qualifying snapshot after expiry is required to alert. Merely expiring a timer does not generate an alert. Disabling drops that guild's pending forecast and re-enabling silently baselines again; it preserves the last successful send and cooldown. A confirmed reset cancels all pending forecasts and silently rebaselines on the next valid snapshot, preserving cooldown history.

Only numeric probabilities in `[0,100]`, valid reset/update timestamps, and observations no older than ten minutes (with one minute of forward clock tolerance) are accepted. Older/equal `updated_at` snapshots and unchanged probability values cannot generate alerts. Invalid probabilities do not prevent confirmed reset processing. Confidence is restricted to low/medium/high; unknown values display as Unknown. The current optional `official_signal` has no verified non-null schema, so Kodded conservatively omits it rather than labeling unsupported upstream content as official confirmation.

The same two-minute monitor and shared cached API client handle both notification types. One pending forecast per guild prevents a backlog of probability alerts. Retries survive restarts and upstream outages; they retain their original observation timestamp. A later valid observation cancels a pending forecast if the qualifying movement has reversed. Otherwise a failed delivery can arrive late when channel access returns. Disable forecast alerts to discard pending work. Discord/SQLite acknowledgement has the same crash/network ambiguity described below; exactly-once delivery is not guaranteed.

## Environment

Copy `.env.example` to `.env` and supply real values locally; never commit `.env`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Existing Discord bot token |
| `CODEX_USER_AGENT` | Yes | Identifying upstream User-Agent; existing production value is preserved |
| `DATABASE_PATH` | No | Defaults to `/app/data/kodded.sqlite`; keep it in the mounted data directory |
| `DISCORD_GUILD_ID` | Legacy only | Existing server for one-time import |
| `DISCORD_CHANNEL_ID` | Legacy only | Existing channel for one-time import |
| `SEND_STARTUP_TEST` | No | Optional startup message; defaults to false |
| `FORECAST_MIN_24H` | No | Default 40; probability floor (0–100) |
| `FORECAST_INCREASE_24H` | No | Default 10; minimum increase in percentage points (1–100) |
| `FORECAST_MIN_48H` | No | Default 60; probability floor (0–100) |
| `FORECAST_INCREASE_48H` | No | Default 15; minimum increase in percentage points (1–100) |
| `FORECAST_COOLDOWN_HOURS` | No | Default 6; per-guild cooldown after success (1–168 hours) |

`SEND_STARTUP_TEST=true` retains the optional startup test message, sent to enabled configured guilds. Leave it false (the default) to avoid messages on every restart.

## SQLite and delivery semantics

The database initializes automatically on startup using `better-sqlite3`:

- `guild_config`: `guild_id` primary key, `channel_id`, `notifications_enabled`, `last_notified_reset`, `baseline_reset`, `forecast_alerts_enabled` (default 0), `created_at`, `updated_at`.
- `monitor_state`: persistent key/value state, including `last_reset_at` and `legacy_migrated`.
- `reset_events`: observed reset timestamps.
- `deliveries`: pending confirmed `(guild_id, reset_at)` pairs, keyed uniquely and linked to guilds/events.
- `forecast_observation`: singleton latest validated forecast snapshot (probabilities, confidence, reset epoch, update timestamp).
- `forecast_guild_state`: each guild's horizon baselines/reset epoch, last successful forecast send time and snapshot.
- `forecast_deliveries`: one pending forecast snapshot and reference probabilities per guild, independent of reset deliveries.

Startup transactionally adds the forecast flag only if absent and creates the new tables idempotently. Existing channels, reset queues, monitor state and legacy migration markers are preserved. No administrator must enable forecasts during deployment; opt-in is a separate deliberate action. No new dependency, service, volume, or production environment variable is required. Optional threshold variables apply to all guilds; each guild still owns its baselines and cooldown. Changing defaults does not replay unchanged snapshots or clear persisted cooldowns.

The global reset observation and queue creation are one transaction. On first launch without state, the current reset is recorded silently. Each successful Discord send updates only that guild’s successful-delivery timestamp and removes its pending item in a transaction. Repeated timestamps and older API responses cannot enqueue duplicate events. Failed deliveries persist across restarts and retry every polling cycle even when the upstream API fails. A later reset does not erase an earlier pending confirmed delivery. Guilds with confirmed notifications disabled do not receive reset alerts; re-enabling drops pending old reset deliveries and starts at the current reset baseline. Explicit bot removal deletes that guild’s configuration; temporary guild unavailability preserves it.

Discord message sends and SQLite commits cannot be atomic. A process crash after Discord accepts a message but before SQLite records it, or an ambiguous network failure, can cause a duplicate on retry. This is **not an exactly-once delivery guarantee**. Run one Kodded process against this database; multiple replicas are unsupported. Queued failures continue retrying until fixed or disabled; old pending resets may arrive after a channel is repaired or changed. Event records are small but currently retained without automatic pruning.

### Safe legacy migration

Before the first upgraded startup, retain the existing `data/state.json` and existing legacy guild/channel environment variables. Startup reads `lastResetAt`, normalizes its timestamp, and imports it into monitor state. It inserts the legacy guild/channel only when both IDs are valid and no SQLite row already exists, using that timestamp as its successful-delivery baseline. Migration does not enqueue or send a historical notification, does not rewrite/delete JSON, and records completion transactionally. Restarting cannot reapply legacy settings over administrator changes.

Missing legacy variables are allowed; existing state still imports, and new servers can use setup. If variables were missing at first migration, use `/codex setup` afterward; changing legacy variables later does not override SQLite. Invalid or corrupt legacy state stops startup rather than discarding deduplication state: repair or restore the file from backup. Once migrated, SQLite is the authoritative source. A genuinely newer reset discovered after migration is delivered normally.

Back up the database using SQLite’s online backup API/tooling, or stop the container and copy the entire data directory, including WAL/SHM files. Never copy only a live main database file and assume the backup is consistent. Keep the original JSON as an additional recovery artifact; restoring only old JSON can replay notifications that SQLite had already acknowledged.

## Docker deployment

```sh
# On a development or explicitly authorized deployment host:
mkdir -p data
# The container uses node UID/GID 1000. Ensure the mounted directory is writable:
sudo chown -R 1000:1000 data
cp .env.example .env
# Edit .env, then:
docker compose up -d --build
docker compose logs -f kodded
```

Do not overwrite an existing production `.env` or data directory. Existing Compose retains `./data:/app/data`, `restart: unless-stopped`, `init: true`, and no exposed ports. The bind mount survives rebuilds and container recreation. The image runs as non-root; host bind-mount ownership is not changed by the image’s directory ownership.

The multi-stage image uses Node 24 on Debian Bookworm slim for glibc-compatible native SQLite support. The build stage includes Python, make, and g++ so `npm ci` can compile the pinned `better-sqlite3` dependency if a prebuilt binary is unavailable. The production stage contains the installed module without the build toolchain. `package-lock.json` pins the dependency graph.

## CI and production constraints

GitHub Actions **Kodded CI / Validate & Build** keeps its existing workflow/job identity and triggers on `main` pushes and PRs targeting `main`. It installs with `npm ci`, checks all source/test JavaScript syntax, runs credential-free automated tests, and builds the production Docker image.

Production remains pull based: a systemd timer on the CloudStack Ubuntu 24.04 VM checks GitHub about every ten minutes; `/usr/local/sbin/kodded-deploy` verifies CI for the target commit before updating `/data/kodded` and rebuilding Compose. The corresponding `kodded-deploy.service` and `.timer` live on the VM. They are not replaced by this change. GitHub Actions never needs SSH to the VM. No inbound access or new infrastructure is needed. Application data remains `/data/kodded/data`; Docker/containerd storage remains on the data volume.

Merging to `main` can trigger production deployment. Review and merge manually only after confirming the existing data mount is writable by UID 1000 and legacy variables/state are retained. No direct VM deployment is required for this PR.

## Development and troubleshooting

With Node 24 and a native compiler toolchain if needed:

```sh
npm ci
npm run check
npm test
docker build -t kodded:ci .
```

Tests use temporary SQLite databases and mocked Discord/API calls; real credentials are never required.

- **No commands:** verify both install scopes, wait for global propagation, refresh the client, and inspect `command_registration_failed` / `guild_command_cleanup_failed` logs.
- **No notifications:** run `/codex config`, confirm notifications are enabled, and check channel permission overrides. A baseline alone does not trigger a notification.
- **Delivery errors:** `notification_failed` includes the guild ID and error. Fix removed channels with setup; restore View Channel, Send Messages, and Embed Links. Other guilds continue receiving alerts.
- **No forecast alerts:** check `/codex forecast-alert config`, opt in explicitly, and confirm that a fresh changed observation meets both conditions for one horizon. Initial levels, small changes, and movements during cooldown are silent. `forecast_check_failed` and `forecast_notification_failed` identify invalid input and delivery failures.
- **API errors:** `reset_check_failed` logs timeouts, invalid timestamps, or rate limiting. The monitor stays running and retries after backoff; existing pending messages still retry.
- **Database readonly:** verify the data mount, host ownership, free disk space, and that `DATABASE_PATH` points inside the persistent mount. SQLite needs directory write access for WAL/SHM files.
- **Legacy migration failure:** preserve the original file, restore valid JSON with a valid `lastResetAt`, and restart. Do not delete valid state to bypass a failure.
