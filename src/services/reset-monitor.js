const { deliverPending, deliverForecastPending } = require('./notification-service');
const log = require('../log');
function createMonitor(client, store, api) {
  let active = null;
  let stopped = false;
  async function cycle() {
    try {
      const data = await api.get('forecast');
      store.observe(data.last_reset_at);
      try { store.observeForecast(data); }
      catch (error) { log('forecast_check_failed', { message: error.message }); }
    }
    catch (error) { log('reset_check_failed', { message: error.message }); }
    // Delivery retries are independent of API availability/rate limiting.
    await deliverPending(client, store);
    await deliverForecastPending(client, store);
  }
  async function checkReset() {
    if (stopped || active) return;
    active = cycle();
    try { await active; } finally { active = null; }
  }
  checkReset.stop = async () => {
    stopped = true;
    await active;
  };
  return checkReset;
}
module.exports = { createMonitor };
