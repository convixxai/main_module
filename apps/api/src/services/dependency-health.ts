// ============================================================
// Health of the outside services the engine uses (C3). Admin only, on
// request: never run on the call path. Each check is one light request
// (a list/status endpoint, or an empty request the provider rejects without
// billing), cached for 60 s, so asking often costs at most one request per
// provider per minute.
//
//   ok          true = reachable and the key is accepted; false = down / key refused;
//               null = not configured or not used (e.g. Redis)
//   latency_ms  time of the check request
//   checked_at  when the check ran (cached for 60 s)
// ============================================================

import { env } from "../config/env";
import { CARTESIA_VERSION } from "./cartesia";

export interface DependencyStatus {
  ok: boolean | null;
  latency_ms: number | null;
  checked_at: string;
  http_status?: number | null;
  detail?: string;
  cached?: boolean;
}

const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;
const cache = new Map<string, { at: number; value: DependencyStatus; pending?: Promise<DependencyStatus> }>();

async function probe(
  url: string,
  init: RequestInit,
  okWhen: (status: number) => boolean,
  explain: (status: number) => string
): Promise<DependencyStatus> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    const ok = okWhen(res.status);
    return { ok, latency_ms: Date.now() - t0, checked_at: new Date().toISOString(), http_status: res.status, detail: explain(res.status) };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      checked_at: new Date().toISOString(),
      http_status: null,
      detail: err instanceof Error && err.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS} ms` : "not reachable",
    };
  }
}

const authExplain = (okText: string) => (s: number) =>
  s === 401 || s === 403 ? "API key refused" : s >= 500 ? `provider error (HTTP ${s})` : okText;
const notConfigured = (what: string): DependencyStatus => ({ ok: null, latency_ms: null, checked_at: new Date().toISOString(), detail: `${what} not configured` });

const CHECKS: Record<string, () => Promise<DependencyStatus>> = {
  // Speech-to-text and Sarvam TTS / translate. Sarvam has no status endpoint:
  // an empty POST /translate is refused with 400 when the key is valid
  // (403 when it is not) and is not billed.
  sarvam: async () =>
    env.sarvam.apiKey
      ? probe(
          "https://api.sarvam.ai/translate",
          { method: "POST", headers: { "api-subscription-key": env.sarvam.apiKey, "Content-Type": "application/json" }, body: "{}" },
          (s) => s === 400 || s === 422 || (s >= 200 && s < 300),
          authExplain("reachable, key accepted")
        )
      : notConfigured("SARVAM_API_KEY"),
  cartesia: async () =>
    env.cartesia.apiKey
      ? probe(
          "https://api.cartesia.ai/voices?limit=1",
          { headers: { "X-API-Key": env.cartesia.apiKey, "Cartesia-Version": CARTESIA_VERSION } },
          (s) => s >= 200 && s < 300,
          authExplain("reachable, key accepted")
        )
      : notConfigured("CARTESIA_API_KEY"),
  elevenlabs: async () =>
    env.elevenlabs.apiKey
      ? probe(
          "https://api.elevenlabs.io/v1/models",
          { headers: { "xi-api-key": env.elevenlabs.apiKey } },
          (s) => s >= 200 && s < 300,
          authExplain("reachable, key accepted")
        )
      : notConfigured("ELEVENLABS_API_KEY"),
  // Google TTS is used by the TTS simulator only, with per-request OAuth
  // tokens; there is no engine-wide key, so only reachability is checked.
  google_tts: async () =>
    probe("https://texttospeech.googleapis.com/v1/voices", {}, (s) => s === 401 || s === 403 || (s >= 200 && s < 300), (s) =>
      s >= 500 ? `provider error (HTTP ${s})` : "reachable (no engine-wide key; used by the TTS simulator only)"
    ),
  openai: async () =>
    env.openai.apiKey
      ? probe(
          `https://api.openai.com/v1/models/${encodeURIComponent(env.openai.model)}`,
          { headers: { Authorization: `Bearer ${env.openai.apiKey}` } },
          (s) => s >= 200 && s < 300,
          (s) => (s === 404 ? `model ${env.openai.model} not available to this key` : authExplain(`reachable, model ${env.openai.model} available`)(s))
        )
      : notConfigured("OPENAI_API_KEY"),
  // Telephony: credentials are per customer, so these check that the provider's
  // API host answers. Calls themselves arrive as WebSockets from the provider.
  vodafone: async () =>
    probe("https://cts.myvi.in:8443/", {}, (s) => s < 500, (s) => (s < 500 ? "VI CPaaS API reachable" : `VI error (HTTP ${s})`)),
  exotel: async () =>
    probe(`${env.exotel.restApiBaseUrl}/`, {},(s) => s < 500, (s) => (s < 500 ? "Exotel API reachable" : `Exotel error (HTTP ${s})`)),
  redis: async () => ({ ok: null, latency_ms: null, checked_at: new Date().toISOString(), detail: "Redis is not used by the engine" }),
};

export const DEPENDENCIES = Object.keys(CHECKS);

/** Groups shown by the SaaS: which checks make up STT / TTS / telephony. */
export const DEPENDENCY_GROUPS: Record<string, string[]> = {
  stt: ["sarvam", "cartesia", "elevenlabs"],
  tts: ["sarvam", "cartesia", "elevenlabs", "google_tts"],
  telephony: ["vodafone", "exotel"],
};

export async function checkDependency(name: string): Promise<DependencyStatus | null> {
  const run = CHECKS[name];
  if (!run) return null;
  const hit = cache.get(name);
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };
  const pending = run().then((value) => {
    cache.set(name, { at: Date.now(), value });
    return value;
  });
  cache.set(name, { at: hit?.at ?? 0, value: hit?.value ?? notConfigured(name), pending });
  return pending;
}
