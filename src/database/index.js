const Database = require('better-sqlite3');
const { mkdirSync, readFileSync } = require('node:fs');
const { dirname } = require('node:path');
const log = require('../log');
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid reset timestamp');
  return new Date(value).toISOString();
}
function validId(id) { return typeof id === 'string' && /^[1-9]\d{16,19}$/.test(id) && BigInt(id) < (1n << 64n); }
function openDatabase(path, { legacyPath, env = {} } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
      notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK(notifications_enabled IN (0,1)),
      last_notified_reset TEXT, baseline_reset TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS reset_events (reset_at TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS deliveries (
      guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
      reset_at TEXT NOT NULL REFERENCES reset_events(reset_at),
      PRIMARY KEY(guild_id, reset_at));`);
  db.pragma('foreign_keys = ON');
  const state = key => db.prepare('SELECT value FROM monitor_state WHERE key=?').get(key)?.value ?? null;
  const setState = (key, value) => db.prepare('INSERT INTO monitor_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const getGuild = id => db.prepare('SELECT * FROM guild_config WHERE guild_id=?').get(id);
  const store = {
    db, state, getGuild, close: () => db.close(),
    latest: () => state('last_reset_at'),
    setup: db.transaction((guild, channel) => {
      if (!validId(guild) || !validId(channel)) throw new Error('Invalid Discord ID');
      const existing = getGuild(guild);
      db.prepare(`INSERT INTO guild_config(guild_id,channel_id,baseline_reset) VALUES (?,?,?)
        ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(guild, channel, state('last_reset_at'));
      return existing;
    }),
    enable: db.transaction((guild, enabled) => {
      const config = getGuild(guild);
      if (!config) throw new Error('Configure a channel with /codex setup first.');
      if (Boolean(config.notifications_enabled) === enabled) return;
      // Re-enabling starts from the current baseline, without replaying disabled-period events.
      db.prepare("UPDATE guild_config SET notifications_enabled=?, baseline_reset=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=?")
        .run(enabled ? 1 : 0, state('last_reset_at'), guild);
      db.prepare('DELETE FROM deliveries WHERE guild_id=?').run(guild);
    }),
    observe: db.transaction(value => {
      const current = timestamp(value), previous = state('last_reset_at');
      if (previous && current <= previous) return;
      setState('last_reset_at', current);
      if (!previous) {
        db.prepare('UPDATE guild_config SET baseline_reset=? WHERE baseline_reset IS NULL').run(current);
        return;
      }
      db.prepare('INSERT OR IGNORE INTO reset_events VALUES (?)').run(current);
      db.prepare(`INSERT OR IGNORE INTO deliveries SELECT guild_id, ? FROM guild_config
        WHERE notifications_enabled=1 AND baseline_reset IS NOT NULL AND baseline_reset < ?`).run(current, current);
    }),
    pending: () => db.prepare(`SELECT d.*, g.channel_id FROM deliveries d JOIN guild_config g USING(guild_id)
      WHERE g.notifications_enabled=1 ORDER BY d.reset_at, d.guild_id`).all(),
    delivered: db.transaction((guild, reset, channel) => {
      // A concurrent setup/disable must not acknowledge delivery to a different configuration.
      if (getGuild(guild)?.channel_id !== channel || !getGuild(guild)?.notifications_enabled) return;
      db.prepare('DELETE FROM deliveries WHERE guild_id=? AND reset_at=?').run(guild, reset);
      db.prepare(`UPDATE guild_config SET last_notified_reset=CASE WHEN last_notified_reset IS NULL OR last_notified_reset < ? THEN ? ELSE last_notified_reset END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=?`).run(reset, reset, guild);
    }),
    removeGuild: id => db.prepare('DELETE FROM guild_config WHERE guild_id=?').run(id)
  };
  try {
    db.transaction(() => {
      if (state('legacy_migrated')) return;
      let legacy = null;
      if (legacyPath) {
        try {
          const raw = JSON.parse(readFileSync(legacyPath, 'utf8')).lastResetAt;
          if (raw != null) legacy = timestamp(raw);
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error(`Legacy state migration failed: ${error.message}`);
        }
      }
      if (!store.latest() && legacy) setState('last_reset_at', legacy);
      if (validId(env.DISCORD_GUILD_ID) && validId(env.DISCORD_CHANNEL_ID)) {
        db.prepare(`INSERT OR IGNORE INTO guild_config(guild_id,channel_id,last_notified_reset,baseline_reset)
          VALUES (?,?,?,?)`).run(env.DISCORD_GUILD_ID, env.DISCORD_CHANNEL_ID, legacy, store.latest());
      } else if (env.DISCORD_GUILD_ID || env.DISCORD_CHANNEL_ID) log('legacy_config_skipped', { reason: 'Both valid legacy Discord IDs are required' });
      setState('legacy_migrated', '1');
    })();
  } catch (error) { db.close(); throw error; }
  return store;
}
module.exports = { openDatabase, timestamp, validId };
