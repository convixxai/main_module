import { env } from "../config/env";

/**
 * Canonical Voicebot URLs for a tenant — derived from `PUBLIC_API_HOST` (or request Host when given).
 * Not stored in DB; returned from GET/PUT Exotel settings and used by the bootstrap route.
 */
export function voicebotUrlsForCustomer(
  customerId: string,
  request?: { hostname: string }
): { voicebot_wss_url: string; voicebot_bootstrap_https_url: string; voicebot_status_callback_url: string } {
  const host = (env.publicApiHost || request?.hostname || "").trim() || "localhost";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const wsProto = host.startsWith("localhost") ? "ws" : "wss";
  return {
    voicebot_wss_url: `${wsProto}://${host}/exotel/voicebot/${customerId}`,
    voicebot_bootstrap_https_url: `${proto}://${host}/exotel/voicebot/bootstrap/${customerId}`,
    voicebot_status_callback_url: `${proto}://${host}/exotel/voicebot/status-callback`,
  };
}
