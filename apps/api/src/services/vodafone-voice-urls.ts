import { env } from "../config/env";

/**
 * Canonical Vodafone (VI) voicebot WebSocket URL for a tenant - derived from
 * `PUBLIC_API_HOST` (or request Host when given), same pattern as
 * exotel-voice-urls.ts's voicebotUrlsForCustomer. Not stored in DB; returned
 * from GET/PUT vodafone-settings so an admin can copy it straight into VI's
 * Streaming Object "WebSocket URL" field.
 *
 * There is no bootstrap/status-callback URL here (unlike Exotel): this route
 * is inbound-only (VI connects to us; we never call out to VI), and VI has
 * not published a general call-status-callback shape yet (see
 * docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.1
 * open item 5).
 */
export function vodafoneVoicebotUrlForCustomer(
  customerId: string,
  request?: { hostname: string }
): { vodafone_voicebot_wss_url: string } {
  const host = (env.publicApiHost || request?.hostname || "").trim() || "localhost";
  const wsProto = host.startsWith("localhost") ? "ws" : "wss";
  return {
    vodafone_voicebot_wss_url: `${wsProto}://${host}/telephony/vodafone/voicebot/${customerId}`,
  };
}
