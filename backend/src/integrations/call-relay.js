import { env } from '../config/env.js';

// Connects a customer's call to a shop. With a masking provider, both sides would see a temporary
// relay number instead of each other's; `direct` (the default until one is contracted) hands out
// the shop's own number, and says so with `masked: false`.
export async function startCall({ shopPhone }) {
  switch (env.callRelay.provider) {
    case 'direct':
      return { masked: false, dial: shopPhone };
    default:
      console.warn(`[call-relay] unknown provider "${env.callRelay.provider}"; giving the shop's own number`);
      return { masked: false, dial: shopPhone };
  }
}
