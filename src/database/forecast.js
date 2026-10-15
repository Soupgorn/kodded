const { forecastPolicy, parseForecast, qualifies } = require('../services/forecast-policy');
function migrateForecast(db) {
  db.transaction(() => {
    if (!db.pragma('table_info(guild_config)').some(column => column.name === 'forecast_alerts_enabled')) {
      db.exec('ALTER TABLE guild_config ADD COLUMN forecast_alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(forecast_alerts_enabled IN (0,1))');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS forecast_observation (
      id INTEGER PRIMARY KEY CHECK(id=1), updated_at TEXT NOT NULL, reset_at TEXT NOT NULL,
      p24 REAL NOT NULL, p48 REAL NOT NULL, confidence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forecast_guild_state (
        guild_id TEXT PRIMARY KEY REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        baseline_24h REAL, baseline_48h REAL, reset_at TEXT,
        last_notified_at INTEGER, last_notified_snapshot TEXT);
      CREATE TABLE IF NOT EXISTS forecast_deliveries (
        guild_id TEXT PRIMARY KEY REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        snapshot_at TEXT NOT NULL, reset_at TEXT NOT NULL,
        baseline_24h REAL NOT NULL, baseline_48h REAL NOT NULL,
        p24 REAL NOT NULL, p48 REAL NOT NULL, confidence TEXT NOT NULL);`);
  })();
}
function attachForecast(store, { env, now }) {
  const { db } = store;
  const policy = forecastPolicy(env);
  const observation = () => db.prepare('SELECT * FROM forecast_observation WHERE id=1').get();
  const guildState = id => db.prepare('SELECT * FROM forecast_guild_state WHERE guild_id=?').get(id);
  const baseline = (guild, data) => db.prepare(`INSERT INTO forecast_guild_state(guild_id,baseline_24h,baseline_48h,reset_at)
    VALUES (?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET baseline_24h=excluded.baseline_24h,
    baseline_48h=excluded.baseline_48h,reset_at=excluded.reset_at`).run(guild, data?.p24 ?? null, data?.p48 ?? null, data?.reset_at ?? null);
  Object.assign(store, {
    forecastPolicy: policy,
    forecastState: guildState,
    forecastObservation: observation,
    // Called within the existing confirmed-reset transaction, even if probabilities are invalid.
    resetForecast: () => {
      db.prepare('DELETE FROM forecast_deliveries').run();
      db.prepare('DELETE FROM forecast_observation').run();
      db.prepare('UPDATE forecast_guild_state SET baseline_24h=NULL,baseline_48h=NULL,reset_at=NULL').run();
    },
    enableForecast: db.transaction((guild, enabled) => {
      const config = store.getGuild(guild);
      if (!config) throw new Error('Configure a channel with /kodded setup first.');
      if (Boolean(config.forecast_alerts_enabled) === enabled) return;
      const current = observation();
      if (enabled && (!current || current.reset_at !== store.latest() || now() - Date.parse(current.updated_at) > policy.maxAgeMs)) {
        throw new Error('A fresh forecast is required before enabling alerts. Please try again later.');
      }
      db.prepare("UPDATE guild_config SET forecast_alerts_enabled=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=?").run(enabled ? 1 : 0, guild);
      db.prepare('DELETE FROM forecast_deliveries WHERE guild_id=?').run(guild);
      baseline(guild, enabled ? current : null);
    }),
    observeForecast: db.transaction(data => {
      const current = parseForecast(data, now(), policy);
      if (current.reset_at !== store.latest()) return; // Never apply an older reset epoch.
      const previous = observation();
      if (previous && current.updated_at <= previous.updated_at) return;
      db.prepare(`INSERT INTO forecast_observation(id,updated_at,reset_at,p24,p48,confidence) VALUES (1,@updated_at,@reset_at,@p24,@p48,@confidence)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,reset_at=excluded.reset_at,
        p24=excluded.p24,p48=excluded.p48,confidence=excluded.confidence`).run(current);
      const changed = !previous || current.p24 !== previous.p24 || current.p48 !== previous.p48;
      for (const config of db.prepare('SELECT guild_id FROM guild_config WHERE forecast_alerts_enabled=1').all()) {
        const guild = config.guild_id;
        const state = guildState(guild);
        if (!state || state.baseline_24h === null || state.reset_at !== current.reset_at) {
          baseline(guild, current); continue;
        }
        if (!changed) continue;
        // A full trigger-sized decrease re-arms that horizon; small oscillations do not.
        const b24 = state.baseline_24h - current.p24 >= policy.increase24 ? current.p24 : state.baseline_24h;
        const b48 = state.baseline_48h - current.p48 >= policy.increase48 ? current.p48 : state.baseline_48h;
        baseline(guild, { p24: b24, p48: b48, reset_at: current.reset_at });
        const pending = db.prepare('SELECT * FROM forecast_deliveries WHERE guild_id=?').get(guild);
        if (pending) {
          if (!qualifies(pending.baseline_24h, pending.baseline_48h, current.p24, current.p48, policy)) {
            db.prepare('DELETE FROM forecast_deliveries WHERE guild_id=?').run(guild);
          }
          // One outstanding forecast movement per guild; never stack alerts during a failure.
          continue;
        }
        if (state.last_notified_at !== null && now() < state.last_notified_at + policy.cooldownMs) continue;
        if (!qualifies(b24, b48, current.p24, current.p48, policy)) continue;
        db.prepare(`INSERT INTO forecast_deliveries(guild_id,snapshot_at,reset_at,baseline_24h,baseline_48h,p24,p48,confidence) VALUES (?,?,?,?,?,?,?,?)`).run(
          guild, current.updated_at, current.reset_at, b24, b48, current.p24, current.p48, current.confidence);
        // Consume this movement at enqueue time, while success alone starts the cooldown.
        baseline(guild, current);
      }
    }),
    pendingForecast: () => db.prepare(`SELECT d.*,g.channel_id FROM forecast_deliveries d JOIN guild_config g USING(guild_id)
      WHERE g.forecast_alerts_enabled=1 ORDER BY d.snapshot_at,d.guild_id`).all(),
    forecastDeliveryCurrent: delivery => {
      const config = store.getGuild(delivery.guild_id);
      return Boolean(config?.forecast_alerts_enabled && config.channel_id === delivery.channel_id &&
        db.prepare('SELECT 1 FROM forecast_deliveries WHERE guild_id=? AND snapshot_at=? AND reset_at=?')
          .get(delivery.guild_id, delivery.snapshot_at, delivery.reset_at));
    },
    deliveredForecast: db.transaction(delivery => {
      if (!store.forecastDeliveryCurrent(delivery)) return;
      db.prepare('DELETE FROM forecast_deliveries WHERE guild_id=?').run(delivery.guild_id);
      db.prepare('UPDATE forecast_guild_state SET last_notified_at=?,last_notified_snapshot=? WHERE guild_id=?')
        .run(now(), delivery.snapshot_at, delivery.guild_id);
    })
  });
}
module.exports = { migrateForecast, attachForecast };
