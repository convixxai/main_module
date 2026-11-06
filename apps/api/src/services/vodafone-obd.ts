// ============================================================
// Vodafone (VI) CPaaS — OBD Campaign API ("With Flow") client
//
// Source: vendor doc "CPaaS-API Documentation (1.0.211)" (shared 2026-10-14,
// Outbound Campaign.html), OBD CAMPAIGN -> "OBD Campaign Api With Flow"
// section. Base host: https://cts.myvi.in:8443/Cpaas/api/v1/obdcampaignapi.
//
// WHY "With Flow" and not "Without Flow":
// "With Flow" campaigns reference a `flowid` built once in VI's portal Flow
// builder. That Flow is expected to already contain a Streaming node bound
// to this tenant's existing Vodafone WS endpoint
// (routes/vodafone-voicebot.ts, GET /telephony/vodafone/voicebot/:customerId
// — same endpoint inbound calls already use), exactly like inbound calls are
// wired up today via a Streaming Object in VI's portal. The per-lead JSON
// base upload (staticCampaignBaseLoad) lets us pass arbitrary extra
// variables per lead, which the Flow forwards into the Streaming node's
// `start.custom_parameters` — the same mechanism types/vodafone-ws.ts
// already documents ("up to 3 key-value pairs, per Streaming Object
// config"). This is how call_type=outbound + campaign_id reach our
// routes/vodafone-voicebot.ts WS handler, without VI needing to publish an
// outbound-call-origination REST contract (still undocumented — see
// vodafone-adapter.ts's triggerOutboundCall stub) or a general call-status
// callback shape (also still undocumented).
//
// ONE-TIME MANUAL PREREQUISITE (outside this codebase): for each customer
// who wants Vodafone OBD campaigns, someone with access to VI's portal must
// build (or reuse) a Flow containing a Streaming node pointed at that
// tenant's Vodafone WS endpoint, with the Flow's base schema including at
// least a `call_type` and `campaign_id` variable bound into that node's
// custom_parameters (VI's Streaming Object allows at most 3). The resulting
// flowid is then stored as outbound_campaigns.vi_flow_id per campaign (or
// reused across campaigns for the same tenant).
//
// "Without Flow" OBD campaigns (createOBDCampaign) are the classic
// IVR-broadcast model — prerecorded prompts + DTMF collection, driven by a
// pingback_URL whose payload shape the shared doc doesn't include (that's a
// separate "Sample Pingback API's" page we don't have). Deliberately not
// implemented here: wiring our conversational AI bot through that model
// would mean guessing the pingback contract, which is exactly the kind of
// fictional-contract guess vodafone-adapter.ts already refuses to make
// elsewhere. Revisit if "With Flow" turns out not to fit.
// ============================================================

import { getTelephonySettings, getDecryptedCredentials, type VodafoneObdCredentials } from "./telephony-settings";

const OBD_API_BASE = "https://cts.myvi.in:8443/Cpaas/api/v1/obdcampaignapi";

export class VodafoneObdError extends Error {
  constructor(message: string, public readonly httpStatus: number, public readonly body?: unknown) {
    super(message);
    this.name = "VodafoneObdError";
  }
}

interface ObdAuthTokenResponse {
  idToken: string;
  expiresIn: number; // seconds, documented as 86400 (24h)
}

const tokenCache = new Map<string, { idToken: string; expiresAt: number }>();
// Refresh a little before actual expiry so an in-flight request never races the deadline.
const TOKEN_SAFETY_MARGIN_MS = 5 * 60_000;

async function obdFetch<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${OBD_API_BASE}/${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new VodafoneObdError(
      `VI OBD API ${path} returned HTTP ${response.status}`,
      response.status,
      body
    );
  }
  return body as T;
}

/**
 * Loads + decrypts this tenant's VI OBD credentials from
 * company_telephony_settings (provider_id='vodafone'). Throws if Vodafone
 * isn't configured/enabled for this customer, or credentials are missing —
 * callers (routes) should catch and turn this into a 400, same pattern as
 * `!settings.is_enabled` checks elsewhere in outbound-campaigns.ts.
 */
export async function getVodafoneObdCredentials(customerId: string): Promise<VodafoneObdCredentials> {
  const settings = await getTelephonySettings(customerId);
  if (!settings || settings.provider_id !== "vodafone" || !settings.is_enabled) {
    throw new VodafoneObdError("Vodafone is not configured/enabled for this customer", 400);
  }
  if (!settings.credentials_enc) {
    throw new VodafoneObdError(
      "Vodafone OBD credentials (username/password/dni) are not set — PUT /customers/:customerId/vodafone-settings with a `credentials` blob first",
      400
    );
  }
  return getDecryptedCredentials<VodafoneObdCredentials>(settings);
}

/**
 * POST .../AuthToken — cached per customer for ~24h (minus a safety margin),
 * same pattern as services/exotel-settings.ts's settings cache: many calls
 * for the same tenant in a short window shouldn't each re-authenticate.
 */
export async function getObdAuthToken(customerId: string): Promise<string> {
  const cached = tokenCache.get(customerId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.idToken;
  }

  const creds = await getVodafoneObdCredentials(customerId);
  if (!creds.username || !creds.password) {
    throw new VodafoneObdError(
      "Vodafone OBD credentials are missing username/password",
      400
    );
  }

  const res = await obdFetch<ObdAuthTokenResponse>("AuthToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
  });

  const expiresAt = Date.now() + Math.max(0, res.expiresIn * 1000 - TOKEN_SAFETY_MARGIN_MS);
  tokenCache.set(customerId, { idToken: res.idToken, expiresAt });
  return res.idToken;
}

export function invalidateObdTokenCache(customerId: string): void {
  tokenCache.delete(customerId);
}

async function authedObdFetch<T>(customerId: string, path: string, body: unknown): Promise<T> {
  const send = async () => {
    const token = await getObdAuthToken(customerId);
    return obdFetch<T>(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  };
  try {
    return await send();
  } catch (err) {
    // Token revoked/expired early on VI's side (or credentials rotated):
    // re-authenticate once and retry.
    if (err instanceof VodafoneObdError && err.httpStatus === 401) {
      invalidateObdTokenCache(customerId);
      return send();
    }
    throw err;
  }
}

export interface CreateObdCampaignWithFlowParams {
  /** VI portal Flow id (encrypted string from VI's Flow builder UI) — see file header prerequisite. */
  flowid: string;
  fromdate: string; // yyyy-mm-dd
  todate: string; // yyyy-mm-dd
  fromtime: string; // HH:mm:ss
  totime: string; // HH:mm:ss
  dialtimeout: string; // seconds
  name: string;
  description: string;
  /** 0 = interval in minutes, 1 = interval in days. */
  retryintervaltype: "0" | "1";
  retryintervalvalue: number;
  retrycount: number;
}

export interface CreateObdCampaignWithFlowResult {
  campainKey: string;
  campaign_Ref_ID: number;
}

export async function createObdCampaignWithFlow(
  customerId: string,
  params: CreateObdCampaignWithFlowParams
): Promise<CreateObdCampaignWithFlowResult> {
  return authedObdFetch<CreateObdCampaignWithFlowResult>(customerId, "createCampaign", params);
}

/**
 * The per-lead variable names this flowid's base schema actually expects
 * (e.g. `["msisdn","call_type","campaign_id"]`), defined in VI's portal when
 * the Flow was built. Fetch once right after createCampaign and cache on
 * outbound_campaigns.vi_base_variable_names, so lead uploads can key each
 * JSON record by the names VI's Flow is actually expecting instead of
 * guessing/hardcoding them.
 */
export async function getSampleBaseHeads(
  customerId: string,
  campaignId: string
): Promise<string[]> {
  const res = await authedObdFetch<{ status: string; variables: string[] }>(
    customerId,
    "getsampleBaseHeads",
    { campaign_ID: campaignId }
  );
  return res.variables ?? [];
}

export interface StaticObdBaseRecord {
  dni: string;
  msisdn: string;
  /** Extra variables, keyed by whatever getSampleBaseHeads returned for this flowid (e.g. call_type, campaign_id). */
  [variableName: string]: string;
}

export async function staticCampaignBaseLoad(
  customerId: string,
  campaignId: string,
  records: StaticObdBaseRecord[]
): Promise<{ status: string }> {
  const res = await authedObdFetch<{ data?: { status?: string; rowsAffected?: number | string }; status?: string | number; message?: string }>(
    customerId,
    "staticCampaignDataIngestion",
    { campaign_ID: campaignId, Records: records }
  );
  // VI answers either {data:{status:"success"}} (its doc) or
  // {data:{rowsAffected:n}} (seen in production 2026-11-06). Anything else,
  // or rowsAffected 0, means VI took none of the records.
  const status = String(res?.data?.status ?? "").toLowerCase();
  const rows = res?.data?.rowsAffected;
  const rowsN = rows === undefined || rows === null || rows === "" ? null : Number(rows);
  if (status === "success" || (rowsN !== null && Number.isFinite(rowsN) && rowsN > 0)) {
    return { status: status || `rowsAffected=${rowsN}` };
  }
  throw new VodafoneObdError(
    rowsN === 0 ? "VI loaded 0 of the numbers (check the dni is an active DNI of the Flow)" : "VI did not accept the campaign base",
    502,
    res
  );
}

const activeDniCache = new Map<string, { at: number; list: string[] }>();
const ACTIVE_DNI_TTL_MS = 5 * 60_000;

/**
 * The calling numbers (DNIs) VI allows for this Flow, as 10-digit strings
 * (VI's own format, e.g. ["9112002517"]). A base record whose dni is not one
 * of these is silently dropped by VI ("Base not loaded", Active DNI 0).
 */
export async function getActiveDniList(customerId: string, flowId: string): Promise<string[]> {
  const key = `${customerId}|${flowId}`;
  const hit = activeDniCache.get(key);
  if (hit && Date.now() - hit.at < ACTIVE_DNI_TTL_MS) return hit.list;
  const res = await authedObdFetch<{ dniList?: unknown[] }>(customerId, "getActiveDNIList", { flowId });
  const list = (Array.isArray(res?.dniList) ? res.dniList : [])
    .map((d) => String(d ?? "").replace(/\D/g, "").slice(-10))
    .filter((d) => d.length === 10);
  activeDniCache.set(key, { at: Date.now(), list });
  return list;
}

export async function startOrStopObdCampaign(
  customerId: string,
  campaignId: string,
  status: "S" | "P"
): Promise<{ status: number; message: string }> {
  return authedObdFetch(customerId, "StartorStop", { campaign_ID: campaignId, status });
}

export interface ObdCampaignStatus {
  campaignName: string;
  campaignType: string;
  currentStatus: string;
  baseDetails: {
    totalBaseReceived: number;
    totalCallInitiated: number;
    totalCallsConnected: number;
    totalCallsNotConnected: number;
    remainingNumbersInQueue: number;
    successRatePercentage: number;
  };
  retryInterval: string;
  retryWithin: number;
  retryAttempts: number;
  campaignCreatedTime: string;
  campaignWindow: string;
  campaignEndDate: string;
  deletedBy: string | null;
  deletedOn: string | null;
}

/**
 * `campaignId` here is VI's numeric campaign_Ref_ID (what VI's portal shows
 * as "ID"): VI answers "invalid campaign_ID" for the campainKey.
 */
export async function getObdCampaignStatus(
  customerId: string,
  campaignId: string
): Promise<ObdCampaignStatus> {
  const res = await authedObdFetch<{ data: ObdCampaignStatus }>(
    customerId,
    "campaignstatus",
    { campaign_ID: campaignId }
  );
  return res.data;
}

/** VI campaign states after which a campaign can no longer dial. */
const TERMINAL_STATUS_RE = /finish|complet|delet|expir|stop|cancel|reject/i;

/**
 * Starts a VI OBD campaign, tolerating VI's refusal for one that is already
 * live. A "With Flow" campaign is scheduled by its own date/time window as
 * soon as its base is loaded, and VI then answers StartorStop(S) with 400
 * "Requested action is not permitted for this campaign" (seen in production
 * 2026-11-06). On that 400 the campaign status is read back: any state that
 * is not finished/deleted means VI will dial it, so it counts as started.
 */
export async function startObdCampaignOrConfirmActive(
  customerId: string,
  campaignId: string,
  /** campaignstatus takes VI's numeric campaign_Ref_ID, not the campainKey. */
  statusId: string | number | null | undefined
): Promise<{ alreadyActive: boolean; viStatus: ObdCampaignStatus | null }> {
  try {
    await startOrStopObdCampaign(customerId, campaignId, "S");
    return { alreadyActive: false, viStatus: null };
  } catch (err) {
    if (!(err instanceof VodafoneObdError) || err.httpStatus !== 400) throw err;
    let status: ObdCampaignStatus | null = null;
    try {
      status = await getObdCampaignStatus(customerId, String(statusId ?? campaignId));
    } catch {
      throw err; // cannot confirm the campaign is live: report VI's original refusal
    }
    if (!status || TERMINAL_STATUS_RE.test(String(status.currentStatus ?? ""))) throw err;
    return { alreadyActive: true, viStatus: status };
  }
}

// ============================================================
// Pull Report API (vendor doc "Call history and report api", REPORTS ->
// Pull Report API). Separate login from the campaign API: the token is
// issued per DNI. Read-only: nothing here places or changes a call.
//
//   POST pullcalldetails/authenticatepullreport {username, password, dni}
//   POST pullcalldetails/pullreport {dni, fromdate, todate, calltype,
//        campaignid?, call_id?}   dates "DD/MM/YYYY"
//   calltype 1 inbound, 2 outbound (campaignid), 3 click-to-call,
//            4 outbound summary (campaignid, no dates)
//
// VI's doc shows the reply only as {"report": "report JSON will be out"}, so
// the row fields are not documented: the reply is normalized to a list of
// rows (report may be an array, an object, or a JSON string) and returned
// as-is, with the raw body kept for anything that does not fit.
// ============================================================

const REPORT_API_BASE = "https://cts.myvi.in:8443/Cpaas/api/v1/pullcalldetails";
const reportTokenCache = new Map<string, { idToken: string; expiresAt: number }>();

export type PullReportCallType = 1 | 2 | 3 | 4;

async function reportFetch<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${REPORT_API_BASE}/${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new VodafoneObdError(`VI Pull Report API ${path} returned HTTP ${response.status}`, response.status, body);
  }
  return body as T;
}

async function getPullReportToken(customerId: string, dni: string): Promise<string> {
  const key = `${customerId}|${dni}`;
  const cached = reportTokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.idToken;
  const creds = await getVodafoneObdCredentials(customerId);
  if (!creds.username || !creds.password) {
    throw new VodafoneObdError("Vodafone credentials are missing username/password", 400);
  }
  const res = await reportFetch<{ idToken?: string; expiresIn?: number }>("authenticatepullreport", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: creds.username, password: creds.password, dni }),
  });
  if (!res?.idToken) throw new VodafoneObdError("VI Pull Report login returned no token", 502, res);
  const ttl = Number(res.expiresIn) > 0 ? Number(res.expiresIn) * 1000 : 3_600_000;
  reportTokenCache.set(key, { idToken: res.idToken, expiresAt: Date.now() + Math.max(60_000, ttl - TOKEN_SAFETY_MARGIN_MS) });
  return res.idToken;
}

/** YYYY-MM-DD -> DD/MM/YYYY (VI's report date format). */
export function toViReportDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function normalizeReportRows(body: unknown): Record<string, unknown>[] {
  let r: unknown = body && typeof body === "object" && "report" in (body as object) ? (body as { report: unknown }).report : body;
  if (r && typeof r === "object" && !Array.isArray(r) && "data" in (r as object)) r = (r as { data: unknown }).data;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return [];
    }
  }
  if (Array.isArray(r)) return r.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (r && typeof r === "object") {
    // a single record, or {something: [rows]}
    const arr = Object.values(r as object).find((v) => Array.isArray(v));
    return Array.isArray(arr) ? (arr.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [r as Record<string, unknown>];
  }
  return [];
}

export interface PullReportResult {
  rows: Record<string, unknown>[];
  /** VI's reply as received (field names are not documented by VI). */
  raw: unknown;
}

export async function pullViCallReport(
  customerId: string,
  params: {
    dni: string;
    calltype: PullReportCallType;
    /** YYYY-MM-DD; not used for calltype 4. */
    fromdate?: string;
    todate?: string;
    /** VI's numeric campaign ID (campaign_Ref_ID); required for calltype 2 and 4. */
    campaignid?: string | number | null;
    call_id?: string | number | null;
  }
): Promise<PullReportResult> {
  const body: Record<string, string> = { dni: params.dni, calltype: String(params.calltype) };
  if (params.calltype !== 4) {
    if (!params.fromdate || !params.todate) throw new VodafoneObdError("fromdate and todate are required", 400);
    body.fromdate = toViReportDate(params.fromdate);
    body.todate = toViReportDate(params.todate);
  }
  if (params.campaignid != null && params.campaignid !== "") body.campaignid = String(params.campaignid);
  if (params.call_id != null && params.call_id !== "") body.call_id = String(params.call_id);

  const send = async () => {
    const token = await getPullReportToken(customerId, params.dni);
    return reportFetch<unknown>("pullreport", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  };
  let raw: unknown;
  try {
    raw = await send();
  } catch (err) {
    if (err instanceof VodafoneObdError && err.httpStatus === 401) {
      reportTokenCache.delete(`${customerId}|${params.dni}`);
      raw = await send();
    } else {
      throw err;
    }
  }
  return { rows: normalizeReportRows(raw), raw };
}
