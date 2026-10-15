const { deliverPending } = require('./notification-service');
const log = require('../log');
function createMonitor(client, store, api) {
  let active = null;
  let stopped = false;
  async function cycle() {
    try { store.observe((await api.get('forecast')).last_reset_at); }
    catch (error) { log('reset_check_failed', { message: error.message }); }
    // Delivery retries are independent of API availability/rate limiting.
    await deliverPending(client, store);
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
