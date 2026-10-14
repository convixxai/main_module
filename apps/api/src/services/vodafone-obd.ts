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
  const token = await getObdAuthToken(customerId);
  return obdFetch<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
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
  const res = await authedObdFetch<{ data: { status: string } }>(
    customerId,
    "staticCampaignDataIngestion",
    { campaign_ID: campaignId, Records: records }
  );
  return res.data;
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
