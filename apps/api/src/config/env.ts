import dotenv from "dotenv";
import path from "path";

/** API package root (`apps/api`), stable regardless of PM2 `cwd`. */
const API_ROOT = path.resolve(__dirname, "../..");

dotenv.config({ path: path.resolve(API_ROOT, ".env") });

/**
 * Default ElevenLabs `voice_id` when `customer_settings.tts_provider` is `elevenlabs` and no
 * `ELEVENLABS_DEFAULT_VOICE_ID` env / DB speaker is set. Override via env only.
 */
export const DEFAULT_ELEVENLABS_TTS_VOICE_ID = "2cdvnKJ5TZi631y5PN1s";

export const env = {
  port: parseInt(process.env.PORT || "8080", 10),

  pg: {
    host: process.env.PG_HOST!,
    port: parseInt(process.env.PG_PORT || "5432", 10),
    user: process.env.PG_USER!,
    password: process.env.PG_PASS!,
    database: process.env.PG_DB!,
  },

  llm: {
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL || "phi3:mini",
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    /**
     * Used only for RAG chat completions (`chatOpenAI` in ask pipeline).
     * Slightly above 0 helps with transliteration/typo alignment (e.g. Chhavani vs Chavni).
     * Set OPENAI_RAG_TEMPERATURE=0 for maximum determinism.
     */
    ragTemperature: parseFloat(
      process.env.OPENAI_RAG_TEMPERATURE ?? "0.25"
    ),
    /** Optional; omit from request when unset (OpenAI default 1). */
    ragTopP: process.env.OPENAI_RAG_TOP_P
      ? parseFloat(process.env.OPENAI_RAG_TOP_P)
      : undefined,
  },

  encryptionKey: process.env.ENCRYPTION_KEY!,

  adminToken: process.env.ADMIN_TOKEN || "",

  /** Sarvam AI (speech-to-text / text-to-speech). Get key from https://dashboard.sarvam.ai/ */
  sarvam: {
    apiKey: process.env.SARVAM_API_KEY || "",
    /** TTS model: `bulbul:v2` (natural default) or `bulbul:v3`. */
    ttsModel: (process.env.SARVAM_TTS_MODEL || "bulbul:v2").trim(),
    /**
     * Sarvam TTS synthesis rate (Hz). Higher = better source quality; we resample to Exotel's rate.
     * Common: 22050, 24000, 16000. Must match what Sarvam returns in WAV / request.
     */
    ttsSpeechSampleRate: (process.env.SARVAM_TTS_SPEECH_SAMPLE_RATE || "22050").trim(),
    /** Optional speaker id (see Sarvam dashboard). */
    ttsSpeaker: (process.env.SARVAM_TTS_SPEAKER || "").trim() || undefined,
    /** Optional pace (Sarvam). */
    ttsPace: process.env.SARVAM_TTS_PACE ? parseFloat(process.env.SARVAM_TTS_PACE) : undefined,
    /**
     * After the last STT WebSocket `data` message, wait this long (ms) before settling the transcript.
     * Lower = faster; too low may cut off late updates. Default tuned for &lt;2s voice SLO. Range 50–5000.
     */
    sttWsIdleAfterTranscriptMs: Math.min(
      5000,
      Math.max(50, parseInt(process.env.SARVAM_STT_WS_IDLE_MS || "250", 10) || 250)
    ),
    /**
     * If the STT WebSocket never sends a `data` transcript after connect+flush, fail fast (ms) and
     * fall back to REST — avoids 60s dead air when the socket hangs (common after many playback marks).
     */
    sttWsFirstDataTimeoutMs: Math.min(
      90_000,
      Math.max(3000, parseInt(process.env.SARVAM_STT_WS_FIRST_DATA_MS || "12000", 10) || 12_000)
    ),
    /** Max time waiting on the Sarvam STT WebSocket overall (ms). Voice default below batch REST. */
    sttWsHardTimeoutMs: Math.min(
      120_000,
      Math.max(8000, parseInt(process.env.SARVAM_STT_WS_HARD_TIMEOUT_MS || "28000", 10) || 28_000)
    ),
    /**
     * When `true`, Sarvam STT WebSocket `language-code` uses `default_language_code` (e.g. en-IN)
     * instead of `unknown` for multilingual calls — fewer wrong-language IDs, less rehint. English-primary lines: enable.
     */
    sttWssUseDefaultLanguage: process.env.SARVAM_STT_WSS_DEFAULT_LANG === "true",
    /**
     * When `true` (default), Sarvam HTTP TTS stream uses `linear16` at the **Exotel** sample rate so the body
     * decodes as raw PCM in one pass (avoids RIFF/codec edge cases that triggered REST fallback + double latency).
     * Set `SARVAM_TTS_STREAM_LINEAR16=false` to use tenant WAV codec for the stream.
     */
    ttsStreamLinear16: process.env.SARVAM_TTS_STREAM_LINEAR16 !== "false",
    /**
     * When `true` (default), use the incremental ReadableStream TTS consumer that pipes PCM chunks
     * to Exotel as they arrive from Sarvam — first audio reaches the caller ~200-400ms after Sarvam
     * starts generating instead of waiting for the full response body. Requires `ttsStreamLinear16`.
     * Set `SARVAM_TTS_INCREMENTAL_STREAM=false` to use the legacy full-buffer path.
     */
    ttsIncrementalStream: process.env.SARVAM_TTS_INCREMENTAL_STREAM !== "false",
  },

  /**
   * Voicebot TTFA / latency tuning (Exotel path).
   */
  voicebot: {
    /**
     * Second STT pass when Sarvam language is outside tenant allowlist.
     * `auto` (default): skip when first transcript is mostly Latin letters (saves ~1s).
     * `always`: always rehint. `never`: never rehint.
     */
    sttRehint: ((): "auto" | "always" | "never" => {
      const v = (process.env.VOICEBOT_STT_REHINT || "auto").trim().toLowerCase();
      if (v === "always" || v === "never") return v;
      return "auto";
    })(),
    /**
     * Hard cap on LLM completion tokens for voice RAG (lower = faster first audio). Default 80.
     */
    voiceLlmMaxTokensCap: Math.min(
      512,
      Math.max(
        32,
        parseInt(process.env.VOICEBOT_VOICE_LLM_MAX_TOKENS || "80", 10) || 80
      )
    ),
    /**
     * When true (default), STT lines that are only conversational fillers (hmm, um, uh, …) skip embedding + RAG + LLM
     * and play `fillerAckText` instead (faster, avoids irrelevant sales prompts). Set `VOICEBOT_FILLER_ACK_ENABLED=false` to restore old behavior.
     */
    fillerAckEnabled: process.env.VOICEBOT_FILLER_ACK_ENABLED !== "false",
    /** Spoken reply for filler-only turns. Keep short for telephony. */
    fillerAckText: (() => {
      const t = (process.env.VOICEBOT_FILLER_ACK_TEXT || "Go ahead, I'm listening.").trim();
      return t.length > 0 ? t : "Go ahead, I'm listening.";
    })(),
  },

  /** ElevenLabs (STT Scribe + TTS). https://elevenlabs.io/docs */
  elevenlabs: {
    apiKey: (process.env.ELEVENLABS_API_KEY || "").trim(),
    /** Default `voice_id` when tenant/agent has no speaker; `ELEVENLABS_DEFAULT_VOICE_ID` overrides. */
    defaultVoiceId: (() => {
      const v = (process.env.ELEVENLABS_DEFAULT_VOICE_ID || "").trim();
      return v.length > 0 ? v : DEFAULT_ELEVENLABS_TTS_VOICE_ID;
    })(),
    /**
     * Optional `voice_id` when using ElevenLabs TTS without an `elevenlabs_avatars` row and no other speaker is set.
     * Voice Library IDs need a **paid** ElevenLabs plan for API use; free tier uses a premade default in code.
     */
    defaultIndianMultilingualVoiceId:
      (process.env.ELEVENLABS_DEFAULT_INDIAN_MULTILINGUAL_VOICE_ID || "").trim() || undefined,
    /** Default TTS model when `customer_settings.tts_model` is missing or Sarvam-specific. */
    defaultTtsModelId:
      (process.env.ELEVENLABS_DEFAULT_TTS_MODEL || "eleven_multilingual_v2").trim(),
  },

  /**
   * Legacy env flag; **Exotel Voicebot ignores this** — use `customer_settings.voicebot_multilingual`
   * per tenant instead. Kept for any future non-voice use.
   */
  voicebotMultilingual: process.env.VOICEBOT_MULTILINGUAL === "true",

  /** Set to `false` to disable verbose RAG pipeline logs (embeddings, OpenAI payloads). */
  logRagTrace: process.env.LOG_RAG_TRACE !== "false",

  /** Pino level: `fatal` | `error` | `warn` | `info` | `debug` | `trace` */
  logLevel: process.env.LOG_LEVEL || "info",

  /**
   * Directory for daily rotating API log files (`convixx-YYYY-MM-DD.log`).
   * Default: `logs` under the API package root (not `process.cwd()`, so PM2 cwd does not break paths).
   */
  logFileDir: (() => {
    const raw = (process.env.LOG_DIR || "logs").trim() || "logs";
    return path.isAbsolute(raw) ? raw : path.resolve(API_ROOT, raw);
  })(),

  /** Set to `false` to disable daily log files (stdout only). */
  logFileEnabled: process.env.LOG_FILE_ENABLED !== "false",

  /** When `true`, log every SQL statement (text + duration). Can be noisy; avoid in prod unless debugging. */
  logDbQueries: process.env.LOG_DB_QUERIES === "true",

  /**
   * When not `false`, log each Voicebot pipeline step with safe payload previews (`voicebot:*` / `voicebotTrace`).
   * Disable with `LOG_VOICEBOT_TRACE=false` if logs are too large.
   */
  logVoicebotTrace: process.env.LOG_VOICEBOT_TRACE !== "false",

  /**
   * Public hostname for this API (no scheme), e.g. `convixx.in`.
   * Used to build canonical Voicebot `wss://` / `https://` URLs (GET/PUT Exotel settings, bootstrap).
   * If empty, the incoming request `Host` is used when a request exists; otherwise `localhost` in URLs.
   */
  publicApiHost: (process.env.PUBLIC_API_HOST || "").trim(),
};

