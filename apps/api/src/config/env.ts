import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

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
  },

  /** Set to `false` to disable verbose RAG pipeline logs (embeddings, OpenAI payloads). */
  logRagTrace: process.env.LOG_RAG_TRACE !== "false",

  /** Pino level: `fatal` | `error` | `warn` | `info` | `debug` | `trace` */
  logLevel: process.env.LOG_LEVEL || "info",

  /** When `true`, log every SQL statement (text + duration). Can be noisy; avoid in prod unless debugging. */
  logDbQueries: process.env.LOG_DB_QUERIES === "true",

  /**
   * Public hostname for this API (no scheme), e.g. `convixx.in`.
   * Used when building default `wss://…` URLs in Exotel bootstrap if `voicebot_wss_url` is unset.
   * If empty, `request.hostname` is used (fine behind nginx with correct Host header).
   */
  publicApiHost: (process.env.PUBLIC_API_HOST || "").trim(),
};

