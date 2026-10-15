# Kodded

Kodded monitors global Codex goodwill resets using [codex-reset.com](https://codex-reset.com/). One Node.js 24 / discord.js v14 process polls every two minutes and distributes notifications across independently configured Discord servers. No inbound ports, public IP, web server, or privileged Gateway intents are required.

## Features and architecture

- Global `/codex` commands; all command responses are ephemeral.
- Independent notification channels and enable/disable settings per server.
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
| `/codex notify enable` | Manage Server / Administrator | Enable future notifications; no disabled-period replay |
| `/codex notify disable` | Manage Server / Administrator | Disable automatic notifications |

All responses, including errors, are ephemeral. Permission checks apply to changing settings, not to the entire command group. Server-level Discord application command restrictions can additionally limit access. Threads, forums, DMs, foreign-server channels, and channels lacking the bot’s three required permissions are rejected. Enabling requires an existing channel configuration.

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

`SEND_STARTUP_TEST=true` retains the optional startup test message, sent to enabled configured guilds. Leave it false (the default) to avoid messages on every restart.

## SQLite and delivery semantics

The database initializes automatically on startup using `better-sqlite3`:

- `guild_config`: `guild_id` primary key, `channel_id`, `notifications_enabled`, `last_notified_reset`, `baseline_reset`, `created_at`, `updated_at`.
- `monitor_state`: persistent key/value state, including `last_reset_at` and `legacy_migrated`.
- `reset_events`: observed reset timestamps.
- `deliveries`: pending `(guild_id, reset_at)` pairs, keyed uniquely and linked to guilds/events.

The global reset observation and queue creation are one transaction. On first launch without state, the current reset is recorded silently. Each successful Discord send updates only that guild’s successful-delivery timestamp and removes its pending item in a transaction. Repeated timestamps and older API responses cannot enqueue duplicate events. Failed deliveries persist across restarts and retry every polling cycle even when the upstream API fails. A later reset does not erase an earlier pending delivery. Disabled guilds do not receive notifications; re-enabling drops pending old deliveries and starts at the current baseline. Explicit bot removal deletes that guild’s configuration; temporary guild unavailability preserves it.

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
- **API errors:** `reset_check_failed` logs timeouts, invalid timestamps, or rate limiting. The monitor stays running and retries after backoff; existing pending messages still retry.
- **Database readonly:** verify the data mount, host ownership, free disk space, and that `DATABASE_PATH` points inside the persistent mount. SQLite needs directory write access for WAL/SHM files.
- **Legacy migration failure:** preserve the original file, restore valid JSON with a valid `lastResetAt`, and restart. Do not delete valid state to bypass a failure.
