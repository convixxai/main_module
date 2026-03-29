import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth";
import { env } from "../config/env";
import {
  sarvamSpeechToText,
  sarvamTextToSpeech,
  type SarvamSttMode,
} from "../services/sarvam";
import { VOICE_TEST_PAGE_HTML } from "./voice-test-page";
import { VOICE_STREAM_PAGE_HTML } from "./voice-stream-page";

const STT_MODES: SarvamSttMode[] = [
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix",
];

const TTS_LANGUAGE_CODES = [
  "bn-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
] as const;

const SAMPLE_RATES = [
  "8000",
  "16000",
  "22050",
  "24000",
  "32000",
  "44100",
  "48000",
] as const;

const AUDIO_CODECS = [
  "wav",
  "mp3",
  "linear16",
  "mulaw",
  "alaw",
  "opus",
  "flac",
  "aac",
] as const;

/** Maps Sarvam output_audio_codec to Content-Type and file extension for downloads */
function codecToDownloadMeta(codec: string | undefined): {
  contentType: string;
  ext: string;
} {
  const c = (codec || "wav").toLowerCase();
  const map: Record<string, { contentType: string; ext: string }> = {
    wav: { contentType: "audio/wav", ext: "wav" },
    mp3: { contentType: "audio/mpeg", ext: "mp3" },
    flac: { contentType: "audio/flac", ext: "flac" },
    opus: { contentType: "audio/opus", ext: "opus" },
    aac: { contentType: "audio/aac", ext: "aac" },
    linear16: { contentType: "audio/wav", ext: "wav" },
    mulaw: { contentType: "audio/wav", ext: "wav" },
    alaw: { contentType: "audio/wav", ext: "wav" },
  };
  return map[c] ?? { contentType: "application/octet-stream", ext: "bin" };
}

function wantsBinaryDownload(query: Record<string, unknown>): boolean {
  const rf = String(query.response_format ?? "").toLowerCase();
  if (rf === "json") return false;
  if (rf === "binary" || rf === "file") return true;
  const dl = String(query.download ?? "");
  return dl === "1" || dl === "true" || dl === "yes";
}

/** Prefer raw audio when client asks for an audio type (Postman: set Accept to audio/wav). */
function wantsBinaryFromAccept(
  accept: string | undefined,
  query: Record<string, unknown>
): boolean {
  if (String(query.response_format ?? "").toLowerCase() === "json") return false;
  if (!accept?.trim()) return false;
  return /\baudio\/[\w*.-]+/i.test(accept);
}

function safeDownloadBasename(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s || s.length > 64) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) return null;
  const base = s.replace(/\.(wav|mp3|flac|opus|aac|bin)$/i, "");
  return base.length > 0 ? base : null;
}

const ttsSchema = z
  .object({
    text: z.string().min(1).max(2500),
    target_language_code: z.enum(TTS_LANGUAGE_CODES),
    speaker: z.string().min(1).max(64).optional(),
    model: z.enum(["bulbul:v3", "bulbul:v2"]).optional().default("bulbul:v3"),
    pace: z.number().min(0.3).max(3).optional(),
    speech_sample_rate: z.enum(SAMPLE_RATES).optional(),
    output_audio_codec: z.enum(AUDIO_CODECS).optional(),
    temperature: z.number().min(0.01).max(2).optional(),
    pitch: z.number().min(-0.75).max(0.75).optional(),
    loudness: z.number().min(0.3).max(3).optional(),
    enable_preprocessing: z.boolean().optional(),
    dict_id: z.string().max(128).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.model === "bulbul:v2" && data.text.length > 1500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bulbul:v2 allows at most 1500 characters",
        path: ["text"],
      });
    }
  });

export const VOICE_CAPABILITIES = {
  speech_to_text: {
    endpoint: "POST /voice/speech-to-text",
    model_default: "saaras:v3",
    modes: STT_MODES,
    mode_descriptions: {
      transcribe: "Transcription in the original spoken language",
      translate: "Translate speech to English text",
      verbatim: "Exact word-for-word transcription",
      translit: "Romanization to Latin script",
      codemix: "Code-mixed text output",
    },
    audio_formats: ["WAV", "MP3", "AAC", "FLAC", "OGG"],
    max_duration_seconds: 30,
    note: "REST API is for short clips (~30s). Use Sarvam batch API for longer audio.",
  },
  text_to_speech: {
    endpoint: "POST /voice/text-to-speech",
    model_default: "bulbul:v3",
    download:
      "Default JSON body has `audios: [\"<long base64>\"]` (Sarvam format)—that string is the WAV/MP3 bytes, not broken. For a real file: add ?response_format=binary or set header Accept: audio/wav (or audio/mpeg if using mp3). Optional ?filename=myclip.",
    languages: TTS_LANGUAGE_CODES.map((code) => ({
      code,
      label: {
        "bn-IN": "Bengali",
        "en-IN": "English (India)",
        "gu-IN": "Gujarati",
        "hi-IN": "Hindi",
        "kn-IN": "Kannada",
        "ml-IN": "Malayalam",
        "mr-IN": "Marathi",
        "od-IN": "Odia",
        "pa-IN": "Punjabi",
        "ta-IN": "Tamil",
        "te-IN": "Telugu",
      }[code],
    })),
    bulbul_v3_speakers: {
      male: [
        "shubh",
        "aditya",
        "rahul",
        "rohan",
        "amit",
        "dev",
        "ratan",
        "varun",
        "manan",
        "sumit",
        "kabir",
        "aayan",
        "ashutosh",
        "advait",
        "anand",
        "tarun",
        "sunny",
        "mani",
        "gokul",
        "vijay",
        "mohit",
        "rehan",
        "soham",
      ],
      female: [
        "ritu",
        "priya",
        "neha",
        "pooja",
        "simran",
        "kavya",
        "ishita",
        "shreya",
        "roopa",
        "amelia",
        "sophia",
        "tanya",
        "shruti",
        "suhani",
        "kavitha",
        "rupali",
      ],
    },
    bulbul_v2_speakers: {
      female: ["anushka", "manisha", "vidya", "arya"],
      male: ["abhilash", "karun", "hitesh"],
    },
    pace: {
      bulbul_v3: { min: 0.5, max: 2.0, default: 1.0 },
      bulbul_v2: { min: 0.3, max: 3.0, default: 1.0 },
    },
    speech_sample_rates_hz: SAMPLE_RATES,
    output_audio_codecs: AUDIO_CODECS,
    temperature: { min: 0.01, max: 2.0, default: 0.6, model: "bulbul:v3 only" },
    max_text_length: { bulbul_v3: 2500, bulbul_v2: 1500 },
  },
};

export async function voiceRoutes(app: FastifyInstance) {
  /** Temporary browser UI for STT/TTS — no auth (API calls still need x-api-key). */
  app.get("/voice/test-ui", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(VOICE_TEST_PAGE_HTML);
  });

  app.get("/voice/stream", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(VOICE_STREAM_PAGE_HTML);
  });

  app.get(
    "/voice/capabilities",
    { preHandler: apiKeyAuth },
    async (_req, reply) => {
      return reply.send(VOICE_CAPABILITIES);
    }
  );

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/voice/speech-to-text",
      { preHandler: apiKeyAuth },
      async (request, reply) => {
        if (!env.sarvam.apiKey) {
          return reply
            .status(503)
            .send({ error: "Sarvam is not configured (SARVAM_API_KEY)" });
        }

        let fileBuffer: Buffer | null = null;
        let filename = "audio.wav";
        let mimeType = "audio/wav";
        const fields: Record<string, string> = {};

        try {
          for await (const part of request.parts()) {
            if (part.type === "file") {
              fileBuffer = await part.toBuffer();
              filename = part.filename || filename;
              mimeType = part.mimetype || mimeType;
            } else {
              fields[part.fieldname] = String(part.value ?? "");
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Invalid multipart";
          return reply.status(400).send({ error: msg });
        }

        if (!fileBuffer || fileBuffer.length === 0) {
          return reply.status(400).send({
            error: "Missing audio file. Send multipart field `file` with WAV/MP3/AAC/FLAC/OGG.",
          });
        }

        const modeRaw = (fields.mode || "transcribe").toLowerCase();
        if (!STT_MODES.includes(modeRaw as SarvamSttMode)) {
          return reply.status(400).send({
            error: `Invalid mode. Use one of: ${STT_MODES.join(", ")}`,
          });
        }
        const mode = modeRaw as SarvamSttMode;

        const model = fields.model?.trim() || "saaras:v3";
        const language_code = fields.language_code?.trim() || undefined;

        let stt: Awaited<ReturnType<typeof sarvamSpeechToText>>;
        try {
          stt = await sarvamSpeechToText({
            fileBuffer,
            filename,
            mimeType,
            model,
            mode,
            language_code,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Sarvam request failed";
          request.log.error({ err }, "sarvam STT failed");
          return reply.status(502).send({ error: msg });
        }

        return reply.status(stt.status).send(stt.body);
      }
    );
  });

  app.post(
    "/voice/text-to-speech",
    { preHandler: apiKeyAuth },
    async (request, reply) => {
      if (!env.sarvam.apiKey) {
        return reply
          .status(503)
          .send({ error: "Sarvam is not configured (SARVAM_API_KEY)" });
      }

      const parsed = ttsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const b = parsed.data;
      const payload: Parameters<typeof sarvamTextToSpeech>[0] = {
        text: b.text,
        target_language_code: b.target_language_code,
        model: b.model,
      };

      if (b.speaker !== undefined) payload.speaker = b.speaker;
      if (b.pace !== undefined) payload.pace = b.pace;
      if (b.speech_sample_rate !== undefined) {
        payload.speech_sample_rate = b.speech_sample_rate;
      }
      if (b.output_audio_codec !== undefined) {
        payload.output_audio_codec = b.output_audio_codec;
      }
      if (b.temperature !== undefined) payload.temperature = b.temperature;
      if (b.pitch !== undefined) payload.pitch = b.pitch;
      if (b.loudness !== undefined) payload.loudness = b.loudness;
      if (b.enable_preprocessing !== undefined) {
        payload.enable_preprocessing = b.enable_preprocessing;
      }
      if (b.dict_id !== undefined) payload.dict_id = b.dict_id;

      let tts: Awaited<ReturnType<typeof sarvamTextToSpeech>>;
      try {
        tts = await sarvamTextToSpeech(payload);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Sarvam request failed";
        request.log.error({ err }, "sarvam TTS failed");
        return reply.status(502).send({ error: msg });
      }

      const q = request.query as Record<string, unknown>;
      const accept = request.headers.accept;
      const asFile =
        (wantsBinaryDownload(q) ||
          wantsBinaryFromAccept(
            typeof accept === "string" ? accept : undefined,
            q
          )) &&
        tts.status === 200 &&
        tts.body &&
        typeof tts.body === "object";

      if (asFile) {
        const data = tts.body as { audios?: string[]; error?: unknown };
        const b64 = data.audios?.[0];
        if (typeof b64 === "string" && b64.length > 0) {
          let buffer: Buffer;
          try {
            buffer = Buffer.from(b64, "base64");
          } catch {
            return reply.status(tts.status).send(tts.body);
          }
          const { contentType, ext } = codecToDownloadMeta(
            b.output_audio_codec ?? undefined
          );
          const base = safeDownloadBasename(q.filename) ?? "speech";
          const filename = `${base}.${ext}`;
          return reply
            .status(200)
            .header("Content-Type", contentType)
            .header(
              "Content-Disposition",
              `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
            )
            .send(buffer);
        }
      }

      return reply.status(tts.status).send(tts.body);
    }
  );
}
