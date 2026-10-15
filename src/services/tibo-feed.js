// Nested tweet fields are observed API shapes, not a stable upstream contract.
const MAX_FEED_AGE_MS = 10 * 60000;
function safePostText(text) {
  const safe = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/@/g, '@\u200b').replace(/</g, '＜').replace(/>/g, '＞')
    .replace(/[\\`*_{}\[\]()#+\-.!|~]/g, '\\$&').trim();
  if (safe.length <= 1024) return safe;
  let result = '';
  for (const char of safe) { if (result.length + char.length > 1022) break; result += char; }
  // Don't end on half of an escaped Markdown token.
  return result.replace(/\\+$/, '') + '…';
}
function parsePost(tweet, now) {
  if (!tweet || typeof tweet !== 'object' || typeof tweet.id !== 'string' ||
      !/^[1-9]\d{16,19}$/.test(tweet.id) || BigInt(tweet.id) >= (1n << 64n) ||
      typeof tweet.text !== 'string' || !tweet.text.trim() || tweet.text.length > 100000 ||
      typeof tweet.at !== 'string' || typeof tweet.url !== 'string') return null;
  const time = Date.parse(tweet.at);
  if (!Number.isFinite(time) || time < Date.UTC(2006, 2, 21) || time > now + 60000) return null;
  let url;
  try { url = new URL(tweet.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) ||
      !new RegExp(`^/thsottiaux/status/${tweet.id}/?$`, 'i').test(url.pathname)) return null;
  const text = safePostText(tweet.text);
  if (!text) return null;
  return { post_id: tweet.id, published_at: new Date(time).toISOString(), text, url: url.origin + url.pathname };
}
function parseFeed(data, now = Date.now()) {
  const fetched = typeof data?.fetched_at === 'string' ? Date.parse(data.fetched_at) : NaN;
  if (data?.stale !== false || !Array.isArray(data.tweets) || !Number.isFinite(fetched) ||
      fetched > now + 60000 || now - fetched > MAX_FEED_AGE_MS) {
    throw new Error('Tibo feed is stale, unavailable or has an unsupported format. Please try again later.');
  }
  const posts = new Map();
  let rejected = 0;
  for (const tweet of data.tweets) {
    const post = parsePost(tweet, now);
    if (!post) { rejected++; continue; }
    if (!posts.has(post.post_id)) posts.set(post.post_id, post);
  }
  if (data.tweets.length && !posts.size) throw new Error('Tibo feed has no valid post entries. Please try again later.');
  return { fetched_at: new Date(fetched).toISOString(), rejected,
    posts: [...posts.values()].sort((a, b) => a.published_at.localeCompare(b.published_at) ||
      (BigInt(a.post_id) < BigInt(b.post_id) ? -1 : 1)) };
}
module.exports = { parseFeed, parsePost, safePostText, MAX_FEED_AGE_MS };
