import { env } from "../config/env";

/**
 * Canonical Voicebot URLs for a tenant — derived from `PUBLIC_API_HOST` (or request Host when given).
 * Not stored in DB; returned from GET/PUT Exotel settings and used by the bootstrap route.
 */
export function voicebotUrlsForCustomer(
  customerId: string,
  request?: { hostname: string }
): { voicebot_wss_url: string; voicebot_bootstrap_https_url: string } {
  const host = (env.publicApiHost || request?.hostname || "").trim() || "localhost";
  return {
    voicebot_wss_url: `wss://${host}/exotel/voicebot/${customerId}`,
    voicebot_bootstrap_https_url: `https://${host}/exotel/voicebot/bootstrap/${customerId}`,
  };
}
