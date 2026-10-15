const { parseFeed, MAX_FEED_AGE_MS } = require('../services/tibo-feed');
const log = require('../log');
const HISTORY_LIMIT = 1000;
const RETENTION_MS = 30 * 86400000;
function migrateTibo(db) {
  db.transaction(() => {
    if (!db.pragma('table_info(guild_config)').some(column => column.name === 'tibo_notifications_enabled')) {
      db.exec('ALTER TABLE guild_config ADD COLUMN tibo_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK(tibo_notifications_enabled IN (0,1))');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS tibo_monitor (
      id INTEGER PRIMARY KEY CHECK(id=1), fetched_at TEXT NOT NULL, retired_before TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0, retired_through_id TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS tibo_posts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL UNIQUE,
        published_at TEXT NOT NULL, text TEXT NOT NULL, url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tibo_guild_state (
        guild_id TEXT PRIMARY KEY REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        baseline_sequence INTEGER NOT NULL, last_notified_post TEXT, last_notified_at INTEGER);
      CREATE TABLE IF NOT EXISTS tibo_deliveries (
        guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
        post_id TEXT NOT NULL REFERENCES tibo_posts(post_id) ON DELETE CASCADE,
        delivered_at INTEGER, PRIMARY KEY(guild_id,post_id));
      CREATE INDEX IF NOT EXISTS tibo_posts_chronology ON tibo_posts(published_at,sequence);
      CREATE INDEX IF NOT EXISTS tibo_pending ON tibo_deliveries(post_id) WHERE delivered_at IS NULL;`);
  })();
}
function attachTibo(store, { now }) {
  const { db } = store;
  const monitor = () => db.prepare('SELECT * FROM tibo_monitor WHERE id=1').get();
  const prune = () => {
    const state = monitor();
    if (!state) return;
    // Retired publication times form a permanent fence; replaying removed history stays silent.
    let cutoff = [state.retired_before, new Date(now() - RETENTION_MS).toISOString()].sort().at(-1);
    const overflow = db.prepare(`SELECT published_at FROM tibo_posts p
      WHERE NOT EXISTS (SELECT 1 FROM tibo_deliveries d WHERE d.post_id=p.post_id AND d.delivered_at IS NULL)
      ORDER BY published_at DESC,sequence DESC LIMIT 1 OFFSET ?`).get(HISTORY_LIMIT);
    if (overflow) cutoff = [cutoff, new Date(Date.parse(overflow.published_at) + 1).toISOString()].sort().at(-1);
    const newestRetired = db.prepare(`SELECT post_id FROM tibo_posts p WHERE published_at < ? AND NOT EXISTS
      (SELECT 1 FROM tibo_deliveries d WHERE d.post_id=p.post_id AND d.delivered_at IS NULL)
      ORDER BY length(post_id) DESC,post_id DESC LIMIT 1`).get(cutoff)?.post_id;
    const retiredId = newestRetired && BigInt(newestRetired) > BigInt(state.retired_through_id) ? newestRetired : state.retired_through_id;
    db.prepare('UPDATE tibo_monitor SET retired_before=?,retired_through_id=? WHERE id=1').run(cutoff, retiredId);
    db.prepare(`DELETE FROM tibo_posts WHERE published_at < ? AND NOT EXISTS
      (SELECT 1 FROM tibo_deliveries d WHERE d.post_id=tibo_posts.post_id AND d.delivered_at IS NULL)`).run(cutoff);
  };
  Object.assign(store, {
    tiboState: guild => db.prepare('SELECT * FROM tibo_guild_state WHERE guild_id=?').get(guild),
    tiboMonitor: monitor,
    pruneTibo: db.transaction(prune),
    observeTibo: db.transaction(data => {
      const feed = parseFeed(data, now());
      const previous = monitor();
      if (previous && feed.fetched_at < previous.fetched_at) return;
      if (feed.rejected) log('tibo_entries_skipped', { count: feed.rejected });
      const cutoff = previous?.retired_before ?? new Date(now() - RETENTION_MS).toISOString();
      db.prepare(`INSERT INTO tibo_monitor(id,fetched_at,retired_before) VALUES (1,?,?)
        ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at`).run(feed.fetched_at, cutoff);
      for (const post of feed.posts) {
        if (post.published_at < cutoff || BigInt(post.post_id) <= BigInt(previous?.retired_through_id ?? '0')) continue;
        const inserted = db.prepare('INSERT OR IGNORE INTO tibo_posts(post_id,published_at,text,url) VALUES (@post_id,@published_at,@text,@url)').run(post);
        if (!inserted.changes) continue;
        const sequence = Number(inserted.lastInsertRowid);
        db.prepare('UPDATE tibo_monitor SET last_sequence=? WHERE id=1').run(sequence);
        // The first complete feed snapshot is a silent global baseline.
        if (!previous) continue;
        db.prepare(`INSERT OR IGNORE INTO tibo_deliveries(guild_id,post_id)
          SELECT g.guild_id,? FROM guild_config g JOIN tibo_guild_state s USING(guild_id)
          WHERE g.tibo_notifications_enabled=1 AND s.baseline_sequence < ?`).run(post.post_id, sequence);
      }
      prune();
    }),
    enableTibo: db.transaction((guild, enabled) => {
      const config = store.getGuild(guild);
      if (!config) throw new Error('Configure a channel with /kodded setup first.');
      if (Boolean(config.tibo_notifications_enabled) === enabled) return;
      const state = monitor();
      if (enabled && (!state || now() - Date.parse(state.fetched_at) > MAX_FEED_AGE_MS)) {
        throw new Error('A fresh Tibo feed is required before enabling notifications. Please try again later.');
      }
      db.prepare("UPDATE guild_config SET tibo_notifications_enabled=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE guild_id=?").run(enabled ? 1 : 0, guild);
      db.prepare('DELETE FROM tibo_deliveries WHERE guild_id=? AND delivered_at IS NULL').run(guild);
      db.prepare(`INSERT INTO tibo_guild_state(guild_id,baseline_sequence) VALUES (?,?) ON CONFLICT(guild_id)
        DO UPDATE SET baseline_sequence=excluded.baseline_sequence`).run(guild, state?.last_sequence ?? 0);
      prune();
    }),
    pendingTibo: () => db.prepare(`SELECT d.guild_id,p.*,g.channel_id FROM tibo_deliveries d
      JOIN tibo_posts p USING(post_id) JOIN guild_config g USING(guild_id)
      WHERE d.delivered_at IS NULL AND g.tibo_notifications_enabled=1
      ORDER BY p.published_at,length(p.post_id),p.post_id,d.guild_id`).all(),
    tiboDeliveryCurrent: delivery => Boolean(store.getGuild(delivery.guild_id)?.tibo_notifications_enabled &&
      store.getGuild(delivery.guild_id)?.channel_id === delivery.channel_id &&
      db.prepare('SELECT 1 FROM tibo_deliveries WHERE guild_id=? AND post_id=? AND delivered_at IS NULL').get(delivery.guild_id, delivery.post_id)),
    deliveredTibo: db.transaction(delivery => {
      if (!store.tiboDeliveryCurrent(delivery)) return;
      db.prepare('UPDATE tibo_deliveries SET delivered_at=? WHERE guild_id=? AND post_id=?').run(now(), delivery.guild_id, delivery.post_id);
      db.prepare('UPDATE tibo_guild_state SET last_notified_post=?,last_notified_at=? WHERE guild_id=?').run(delivery.post_id, now(), delivery.guild_id);
      prune();
    })
  });
}
module.exports = { migrateTibo, attachTibo, HISTORY_LIMIT, RETENTION_MS };
