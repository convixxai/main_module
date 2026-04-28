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

function appendForm(params: URLSearchParams, key: string, value: string): void {
  params.append(key, value);
}

/**
 * POST Calls/connect with Basic auth (same semantics as api_key:api_token in URL).
 */
export async function exotelConnectCall(
  params: ExotelConnectCallParams
): Promise<ExotelConnectCallSuccess> {
  const base = env.exotel.restApiBaseUrl;
  const url = `${base}/v1/Accounts/${encodeURIComponent(params.accountSid)}/Calls/connect`;

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
  if (params.streamBegin) appendForm(body, "StreamBegin", params.streamBegin);
  if (params.customField) appendForm(body, "CustomField", params.customField);
  if (params.startPlaybackToNew)
    appendForm(body, "StartPlaybackToNew", params.startPlaybackToNew);
  if (params.startPlaybackValueNew)
    appendForm(body, "StartPlaybackValueNew", params.startPlaybackValueNew);
  if (params.statusCallback) appendForm(body, "StatusCallback", params.statusCallback);
  if (params.statusCallbackEvents?.length) {
    for (const ev of params.statusCallbackEvents) {
      appendForm(body, "StatusCallbackEvents", ev);
    }
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
  let parsed: unknown;
  try {
    parsed = text.length ? JSON.parse(text) : {};
  } catch {
    throw new ExotelUpstreamError(
      "Exotel returned non-JSON response",
      response.status || 502
    );
  }

  const obj = parsed as Record<string, unknown>;
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
