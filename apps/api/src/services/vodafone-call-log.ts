// ============================================================
// Vodafone call log: one exotel_call_sessions row per Vodafone call, the
// same table, columns and status values the Exotel voicebot writes
// (services/exotel-settings.ts createCallSession / endCallSession), so
// Vodafone calls show up wherever calls are read: the SaaS Calls page and
// dashboards, the campaign filter (outbound_campaign_leads.session_id), the
// CRM call sync, and GET /vodafone/reports/convixx/*.
//
// Never on the call's critical path: every write is fire-and-forget, a
// failure is logged and the call carries on. Off switch:
// VODAFONE_CALL_LOG_ENABLED=false.
//
// Row shape (as for Exotel):
//   direction  outbound (campaign) | inbound
//   from/to    outbound: from = our DNI, to = customer; inbound: the reverse
//   status     'active' while live, then 'stopped:<reason>' / 'ws_closed'
//   metadata   {provider:'vodafone', callee_answered:true, campaign_id,
//               vi_call_id, room_id, ...}  (VI connects the stream only when
//               the call is answered)
// ============================================================

import { pool } from "../config/db";
import { updateExotelCallSessionLanguage } from "./exotel-settings";

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

interface Entry {
  id: Promise<string | null>;
  ended: boolean;
  language: string | null;
}

const entries = new Map<string, Entry>();

export function vodafoneCallLogEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(String(process.env.VODAFONE_CALL_LOG_ENABLED ?? "true").trim());
}

export interface VodafoneCallLogStart {
  streamId: string;
  callId: string;
  customerId: string;
  direction: "inbound" | "outbound";
  /** Customer number (10 digits) or null when it could not be told. */
  customerNumber: string | null;
  /** Our number on this call (DNI), if known. */
  ourNumber: string | null;
  chatSessionId: string | null;
  agentId: string | null;
  campaignId: string | null;
  voicebotMultilingual: boolean;
  defaultLanguageCode: string | null;
  metadata: Record<string, unknown>;
}

/** Starts the row in the background. Returns at once. */
export function startVodafoneCallLog(p: VodafoneCallLogStart, log: Log): void {
  if (!vodafoneCallLogEnabled() || entries.has(p.streamId)) return;
  const fmt = (d: string | null) => (d && d.length === 10 ? `+91${d}` : d || null);
  const from = p.direction === "outbound" ? fmt(p.ourNumber) : fmt(p.customerNumber);
  const to = p.direction === "outbound" ? fmt(p.customerNumber) : fmt(p.ourNumber);
  const entry: Entry = { ended: false, language: p.defaultLanguageCode, id: Promise.resolve(null) };
  // Taken now, not when the INSERT runs: a slow database must not shift the call's times.
  const startedAt = new Date().toISOString();
  entry.id = (async () => {
    try {
      const r = await pool.query(
        `INSERT INTO exotel_call_sessions
           (customer_id, exotel_call_sid, exotel_stream_sid, direction, from_number, to_number, status,
            chat_session_id, agent_id, metadata, voicebot_multilingual, default_language_code, current_language_code, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9::jsonb, $10, $11, $11, ($12::timestamptz AT TIME ZONE 'UTC'))
         RETURNING id`,
        [
          p.customerId,
          p.callId || null,
          p.streamId,
          p.direction,
          from,
          to,
          p.chatSessionId,
          p.agentId,
          JSON.stringify({ provider: "vodafone", callee_answered: true, campaign_id: p.campaignId, ...p.metadata }),
          p.voicebotMultilingual,
          p.defaultLanguageCode,
          startedAt,
        ]
      );
      const id: string = r.rows[0].id;
      if (p.campaignId && p.customerNumber) {
        // Campaign link the SaaS reads (outbound_campaign_leads.session_id).
        await pool.query(
          `UPDATE outbound_campaign_leads SET session_id = $1
            WHERE id = (
              SELECT id FROM outbound_campaign_leads
               WHERE campaign_id = $2 AND RIGHT(regexp_replace(phone_number, '\\D', '', 'g'), 10) = $3
               ORDER BY (status = 'calling') DESC, last_attempt_at DESC NULLS LAST, created_at DESC
               LIMIT 1
            )`,
          [id, p.campaignId, p.customerNumber]
        );
      }
      return id;
    } catch (err) {
      log.warn({ err, streamId: p.streamId }, "vodafone-call-log: could not record the call (call unaffected)");
      return null;
    }
  })();
  entries.set(p.streamId, entry);
}

/** Records the call's current language when it changes (background). */
export function noteVodafoneCallLanguage(streamId: string, languageCode: string | null | undefined): void {
  const e = entries.get(streamId);
  if (!e || !languageCode || e.ended || e.language === languageCode) return;
  e.language = languageCode;
  void e.id.then((id) => (id ? updateExotelCallSessionLanguage(id, languageCode) : undefined)).catch(() => {});
}

/** Ends the row (background). Safe to call more than once (stop, then close). */
export function endVodafoneCallLog(streamId: string, status: string, log: Log): void {
  const e = entries.get(streamId);
  if (!e || e.ended) return;
  e.ended = true;
  const endedAt = new Date().toISOString(); // the hang-up time, even if the row is written later
  void e.id
    .then((id) =>
      id
        ? pool.query(
            `UPDATE exotel_call_sessions SET status = $1, ended_at = ($2::timestamptz AT TIME ZONE 'UTC') WHERE id = $3`,
            [status, endedAt, id]
          )
        : undefined
    )
    .catch((err) => log.warn({ err, streamId }, "vodafone-call-log: could not close the call row"))
    .finally(() => {
      // Keep the entry briefly so a late duplicate stop/close stays a no-op.
      setTimeout(() => entries.delete(streamId), 60_000).unref?.();
    });
}

/** For tests: wait until the row of a stream is written. */
export async function vodafoneCallLogId(streamId: string): Promise<string | null> {
  return (await entries.get(streamId)?.id) ?? null;
}
