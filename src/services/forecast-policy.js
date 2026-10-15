const DEFAULTS = Object.freeze({ min24: 40, increase24: 10, min48: 60, increase48: 15, cooldownMs: 6 * 3600000, maxAgeMs: 10 * 60000 });
function forecastPolicy(env = {}) {
  const number = (key, fallback, min, max) => {
    if (env[key] === undefined) return fallback;
    const value = Number(env[key]);
    if (!String(env[key]).trim() || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid environment variable: ${key}`);
    return value;
  };
  return {
    min24: number('FORECAST_MIN_24H', DEFAULTS.min24, 0, 100),
    increase24: number('FORECAST_INCREASE_24H', DEFAULTS.increase24, 1, 100),
    min48: number('FORECAST_MIN_48H', DEFAULTS.min48, 0, 100),
    increase48: number('FORECAST_INCREASE_48H', DEFAULTS.increase48, 1, 100),
    cooldownMs: number('FORECAST_COOLDOWN_HOURS', 6, 1, 168) * 3600000,
    maxAgeMs: DEFAULTS.maxAgeMs
  };
}
function qualifies(b24, b48, p24, p48, policy) {
  return (p24 >= policy.min24 && p24 - b24 >= policy.increase24) ||
    (p48 >= policy.min48 && p48 - b48 >= policy.increase48);
}
function parseForecast(data, now = Date.now(), policy = DEFAULTS) {
  const p24 = data?.probabilities?.rounded_24h, p48 = data?.probabilities?.rounded_48h;
  const updated = typeof data?.updated_at === 'string' ? Date.parse(data.updated_at) : NaN;
  const reset = typeof data?.last_reset_at === 'string' ? Date.parse(data.last_reset_at) : NaN;
  if (![p24, p48].every(p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100) ||
      !Number.isFinite(updated) || !Number.isFinite(reset) || reset > updated || updated > now + 60000 || now - updated > policy.maxAgeMs) {
    throw new Error('Forecast data is missing, invalid or stale; please try again later.');
  }
  return { p24, p48, updated_at: new Date(updated).toISOString(), reset_at: new Date(reset).toISOString(),
    confidence: ['low', 'medium', 'high'].includes(data.confidence) ? data.confidence : 'Unknown' };
}
module.exports = { DEFAULTS, forecastPolicy, qualifies, parseForecast };
