// ============================================================
// Exotel REST — Connect Two Numbers (Make a Call)
// Reference: docs/EXOTEL_OUTBOUND_CALL_API_SPEC.md
// ============================================================

import { env } from "../config/env";

export interface ExotelConnectCallParams {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  from: string;
  to: string;
  callerId: string;
  /**
   * HTTPS origin for REST (`https://api.exotel.com` vs `https://api.in.exotel.com`).
   * Usually from `customer_exotel_settings.exotel_subdomain`. Omitted → `env.exotel.restApiBaseUrl`.
   */
  restApiBaseUrl?: string;
  callType?: string;
  timeLimit?: number;
  timeOut?: number;
  waitUrl?: string;
  record?: boolean;
  recordingChannels?: string;
  recordingFormat?: string;
  streamUrl?: string;
  streamBegin?: string;
  customField?: string;
  startPlaybackToNew?: string;
  startPlaybackValueNew?: string;
  statusCallback?: string;
  statusCallbackEvents?: string[];
  statusCallbackContentType?: string;
}

export interface ExotelConnectCallSuccess {
  raw: Record<string, unknown>;
  call: Record<string, unknown> | null;
}

export class ExotelUpstreamError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly exotelStatus?: number
  ) {
    super(message);
    this.name = "ExotelUpstreamError";
  }
}

/** Exotel rejects spaced variants — Connect API expects exactly `atLeg1connect` | `atLeg2connect`. */
export type ExotelStreamBeginWire = "atLeg1connect" | "atLeg2connect";

/**
 * Normalize docs/UI variants (`at Leg2Connect`, etc.) to wire format Exotel accepts.
 * Throws {@link ExotelUpstreamError} when `raw` is non-empty but not recognized.
 */
export function normalizeStreamBeginForExotel(
  raw: string | undefined
): ExotelStreamBeginWire | undefined {
  if (!raw?.trim()) return undefined;
  const c = raw.trim().replace(/\s+/g, "").toLowerCase();
  if (c === "atleg1connect") return "atLeg1connect";
  if (c === "atleg2connect") return "atLeg2connect";
  throw new ExotelUpstreamError(
    `Invalid StreamBegin "${raw}". Use atLeg1connect or atLeg2connect.`,
    400,
    400
  );
}

function appendForm(params: URLSearchParams, key: string, value: string): void {
  params.append(key, value);
}

/**
 * Maps `customer_exotel_settings.exotel_subdomain` to REST base URL.
 * Exotel API keys are tied to a regional host (Singapore vs Mumbai); calling the wrong host returns 401.
 * Accepts values like `api.exotel.com`, `api.in.exotel.com`, or `https://api.exotel.com`.
 */
export function restApiBaseUrlFromSubdomain(
  exotelSubdomain: string | null | undefined
): string | null {
  const raw = exotelSubdomain?.trim();
  if (!raw) return null;
  const host = raw
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    ?.trim();
  if (!host) return null;
  if (!/[.]/.test(host)) return null;
  return `https://${host}`;
}

/** Exotel defaults to XML unless the URL ends with `.json`. See developer.exotel.com Make a Call API. */
function connectJsonUrl(accountSid: string, restBase: string): string {
  const base = restBase.replace(/\/$/, "");
  return `${base}/v1/Accounts/${encodeURIComponent(accountSid)}/Calls/connect.json`;
}

/** Pull flat tag text from XML snippet (first match). */
function xmlInnerTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Parse `<TwilioResponse><RestException>...</RestException>` style errors. */
function tryParseXmlRestException(text: string): {
  message: string;
  status?: number;
} | null {
  if (!/<RestException/i.test(text)) return null;
  const message =
    xmlInnerTag(text, "Message") ??
    xmlInnerTag(text, "message") ??
    "Exotel API error";
  const statusRaw = xmlInnerTag(text, "Status") ?? xmlInnerTag(text, "status");
  const statusNum =
    statusRaw != null && statusRaw !== ""
      ? parseInt(statusRaw, 10)
      : undefined;
  return {
    message,
    status: Number.isFinite(statusNum) ? statusNum : undefined,
  };
}

/** Parse `<Call>...</Call>` success XML into an object shaped like JSON `Call`. */
function tryParseXmlCallSuccess(text: string): Record<string, unknown> | null {
  const block = text.match(/<Call>\s*([\s\S]*?)<\/Call>/i);
  if (!block) return null;
  const inner = block[1];
  const call: Record<string, unknown> = {};
  const tagRe = /<([A-Za-z][A-Za-z0-9]*)>([^<]*)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(inner)) !== null) {
    const v = m[2];
    call[m[1]] = v === "" ? null : v;
  }
  return Object.keys(call).length > 0 ? call : null;
}

function parseExotelResponseBody(text: string): Record<string, unknown> {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed.length) return {};

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const xmlErr = tryParseXmlRestException(text);
    if (xmlErr) {
      const synthetic: Record<string, unknown> = {
        RestException: {
          Message: xmlErr.message,
          ...(xmlErr.status != null ? { Status: xmlErr.status } : {}),
        },
      };
      return synthetic;
    }

    const callXml = tryParseXmlCallSuccess(text);
    if (callXml) {
      return { Call: callXml };
    }

    const preview = trimmed.replace(/\s+/g, " ").slice(0, 240);
    throw new ExotelUpstreamError(
      `Exotel returned a response that is neither JSON nor recognized Exotel XML. First characters: ${preview}`,
      502
    );
  }
}

/**
 * POST Calls/connect with Basic auth (same semantics as api_key:api_token in URL).
 */
export async function exotelConnectCall(
  params: ExotelConnectCallParams
): Promise<ExotelConnectCallSuccess> {
  const restBase =
    params.restApiBaseUrl?.trim().replace(/\/$/, "") || env.exotel.restApiBaseUrl;
  const url = connectJsonUrl(params.accountSid, restBase);

  const body = new URLSearchParams();
  appendForm(body, "From", params.from);
  appendForm(body, "To", params.to);
  appendForm(body, "CallerId", params.callerId);

  if (params.callType) appendForm(body, "CallType", params.callType);
  if (params.timeLimit != null) appendForm(body, "TimeLimit", String(params.timeLimit));
  if (params.timeOut != null) appendForm(body, "TimeOut", String(params.timeOut));
  if (params.waitUrl) appendForm(body, "WaitUrl", params.waitUrl);
  if (params.record === true) appendForm(body, "Record", "true");
  if (params.recordingChannels)
    appendForm(body, "RecordingChannels", params.recordingChannels);
  if (params.recordingFormat)
    appendForm(body, "RecordingFormat", params.recordingFormat);
  if (params.streamUrl) appendForm(body, "StreamUrl", params.streamUrl);
  if (params.streamBegin) {
    const sb = normalizeStreamBeginForExotel(params.streamBegin);
    if (sb) appendForm(body, "StreamBegin", sb);
  }
  if (params.customField) appendForm(body, "CustomField", params.customField);
  if (params.startPlaybackToNew)
    appendForm(body, "StartPlaybackToNew", params.startPlaybackToNew);
  if (params.startPlaybackValueNew)
    appendForm(body, "StartPlaybackValueNew", params.startPlaybackValueNew);
  if (params.statusCallback) appendForm(body, "StatusCallback", params.statusCallback);
  // Exotel expects indexed keys (`StatusCallbackEvents[0]=terminal`), not repeated bare keys.
  if (params.statusCallbackEvents?.length) {
    params.statusCallbackEvents.forEach((ev, i) => {
      appendForm(body, `StatusCallbackEvents[${i}]`, ev);
    });
  }
  if (params.statusCallbackContentType)
    appendForm(body, "StatusCallbackContentType", params.statusCallbackContentType);

  const auth = Buffer.from(`${params.apiKey}:${params.apiToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await response.text();
  const obj = parseExotelResponseBody(text);
  const restEx = obj.RestException as { Status?: number; Message?: string } | undefined;
  if (restEx?.Message != null) {
    throw new ExotelUpstreamError(
      String(restEx.Message),
      response.status || 502,
      typeof restEx.Status === "number" ? restEx.Status : undefined
    );
  }

  if (!response.ok) {
    throw new ExotelUpstreamError(
      `Exotel HTTP ${response.status}`,
      response.status || 502
    );
  }

  const call =
    obj.Call != null && typeof obj.Call === "object"
      ? (obj.Call as Record<string, unknown>)
      : null;

  return { raw: obj, call };
}
