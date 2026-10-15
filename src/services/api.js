class CodexApi {
  constructor(userAgent, request = fetch, now = Date.now) {
    this.userAgent = userAgent; this.request = request; this.now = now;
    this.cache = new Map(); this.inflight = new Map(); this.retryAfter = 0;
  }
  async get(endpoint, { fresh = false } = {}) {
    if (!['forecast', 'timeline'].includes(endpoint)) throw new Error('Invalid API endpoint');
    if (this.now() < this.retryAfter) throw new Error('Codex API rate limited; retry later.');
    const cached = this.cache.get(endpoint);
    if (!fresh && cached && this.now() - cached.time < 90_000) return cached.data;
    if (this.inflight.has(endpoint)) return this.inflight.get(endpoint);
    const pending = this.fetch(endpoint);
    this.inflight.set(endpoint, pending);
    try { return await pending; } finally { this.inflight.delete(endpoint); }
  }
  async fetch(endpoint) {
    const response = await this.request(`https://codex-reset.com/api/${endpoint}`, {
      headers: { 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(15000)
    });
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = Number(header);
      const delay = header && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.now();
      this.retryAfter = this.now() + Math.max(120000, Number.isFinite(delay) ? delay : 120000);
      throw new Error('Codex API rate limited; retry later.');
    }
    if (!response.ok) throw new Error(`Codex API returned ${response.status}`);
    const data = await response.json();
    this.cache.set(endpoint, { data, time: this.now() });
    return data;
  }
}
module.exports = { CodexApi };
