import dotenv from "dotenv";
import path from "path";

/** API package root (`apps/api`), stable regardless of PM2 `cwd`. */
const API_ROOT = path.resolve(__dirname, "../..");

dotenv.config({ path: path.resolve(API_ROOT, ".env") });

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
  },

  /**
   * VOICEBOT MULTILINGUAL SUPPORT (TEMPORARY: English-only by default)
   *
   * When `false` (default): STT is forced to English (`en-IN`), TTS always uses English.
   * When `true`: STT auto-detects language, TTS follows detected language (all Indian languages).
   *
   * Set VOICEBOT_MULTILINGUAL=true in .env when ready to support all Indian languages.
   * See: artifacts/voicebot_language_fix_analysis.md for context on why this was disabled.
   */
  voicebotMultilingual: process.env.VOICEBOT_MULTILINGUAL === "false",

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

