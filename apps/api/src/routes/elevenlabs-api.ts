import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { env } from "../config/env";
import { elevenLabsListVoices } from "../services/elevenlabs";
import {
  listElevenlabsAvatars,
  getElevenlabsAvatar,
  createElevenlabsAvatar,
  updateElevenlabsAvatar,
  deleteElevenlabsAvatar,
  setDefaultElevenlabsAvatar,
} from "../services/elevenlabs-avatars";

const bcp47 = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Invalid BCP-47 code (e.g. en-IN)");

const languageVoiceMapEntry = z
  .object({
    voice_id: z.string().min(1).optional(),
    model_id: z.string().nullable().optional(),
    voice_settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const languageVoiceMap = z.record(bcp47, languageVoiceMapEntry);

const createElAvatarSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  voice_id: z.string().min(1).max(128),
  model_id: z.string().max(128).nullable().optional(),
  voice_settings: z.record(z.string(), z.unknown()).optional(),
  language_voice_map: languageVoiceMap.optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

const updateElAvatarSchema = createElAvatarSchema.partial().extend({
  name: z.string().min(1).max(120).optional(),
});

function isPgUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === "23505";
}

/**
 * Match requested BCP-47 tag against ElevenLabs metadata.
 * Important: many premade voices have `labels.language` = `en` only, but support Hindi etc.
 * via `verified_languages` — filtering must use that array too.
 */
function voiceMatchesLanguageFilter(
  voice: Record<string, unknown>,
  want: string
): boolean {
  const w = want.trim().toLowerCase();
  const primary = w.split("-")[0] || w;

  const labels = voice.labels as Record<string, unknown> | undefined;
  const labelLang =
    typeof labels?.language === "string" ? labels.language.toLowerCase() : "";
  if (
    labelLang &&
    (labelLang === primary ||
      labelLang === w ||
      w.startsWith(`${labelLang}-`) ||
      primary === labelLang)
  ) {
    return true;
  }

  const verified = voice.verified_languages;
  if (Array.isArray(verified)) {
    for (const entry of verified) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const el =
        typeof e.language === "string" ? e.language.toLowerCase() : "";
      const loc =
        typeof e.locale === "string" ? e.locale.toLowerCase().replace(/_/g, "-") : "";
      if (el === primary || el === w) return true;
      if (loc === w) return true;
      if (loc) {
        const locPrimary = loc.split("-")[0] || "";
        if (locPrimary === primary) return true;
      }
    }
  }

  const name = typeof voice.name === "string" ? voice.name.toLowerCase() : "";
  return name.includes(primary);
}

/** Voice lists this model in `high_quality_base_model_ids` or a `verified_languages` row. */
function voiceSupportsModel(
  voice: Record<string, unknown>,
  modelId: string
): boolean {
  const m = modelId.trim();
  if (!m) return true;
  const hq = voice.high_quality_base_model_ids;
  if (Array.isArray(hq) && hq.some((x) => String(x) === m)) return true;
  const verified = voice.verified_languages;
  if (Array.isArray(verified)) {
    return verified.some(
      (x) =>
        x &&
        typeof x === "object" &&
        String((x as Record<string, unknown>).model_id) === m
    );
  }
  return false;
}

export async function elevenlabsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/voice/elevenlabs/voices",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!env.elevenlabs.apiKey?.trim()) {
        return reply
          .status(503)
          .send({ error: "ELEVENLABS_API_KEY is not configured on this server" });
      }
      const q = request.query as Record<string, unknown>;
      const langRaw = typeof q.language === "string" ? q.language.trim() : "";
      const langParse = langRaw ? bcp47.safeParse(langRaw) : null;
      if (langRaw && !langParse?.success) {
        return reply.status(400).send({ error: langParse?.error.flatten() });
      }

      const forward: Record<string, string> = {};
      const sl = q.show_legacy;
      if (sl === true || sl === "true" || sl === "1") forward.show_legacy = "true";
      if (sl === false || sl === "false" || sl === "0") forward.show_legacy = "false";
      const ps = q.page_size;
      if (ps !== undefined && ps !== "") {
        const n = typeof ps === "number" ? ps : parseInt(String(ps), 10);
        if (Number.isFinite(n) && n > 0 && n <= 500) {
          forward.page_size = String(Math.floor(n));
        } else if (String(ps).trim() !== "") {
          return reply.status(400).send({
            error: "page_size must be an integer between 1 and 500",
          });
        }
      }
      const npt = q.next_page_token;
      if (typeof npt === "string" && npt.trim()) {
        forward.next_page_token = npt.trim();
      }

      const supportsModelRaw =
        typeof q.supports_model === "string" ? q.supports_model.trim() : "";
      if (supportsModelRaw.length > 128) {
        return reply.status(400).send({
          error: "supports_model must be at most 128 characters",
        });
      }

      let listed: { status: number; body: unknown };
      try {
        listed = await elevenLabsListVoices(forward);
      } catch (err) {
        request.log.error({ err }, "ElevenLabs list voices failed");
        return reply.status(502).send({ error: "ElevenLabs request failed" });
      }

      if (listed.status !== 200) {
        return reply.status(listed.status).send(listed.body);
      }

      const rawBody = listed.body as Record<string, unknown>;
      let voices = Array.isArray(rawBody.voices) ? rawBody.voices : [];
      if (langParse?.success) {
        const tag = langParse.data;
        voices = voices.filter(
          (v) =>
            v &&
            typeof v === "object" &&
            voiceMatchesLanguageFilter(v as Record<string, unknown>, tag)
        );
      }
      if (supportsModelRaw) {
        voices = voices.filter(
          (v) =>
            v &&
            typeof v === "object" &&
            voiceSupportsModel(v as Record<string, unknown>, supportsModelRaw)
        );
      }

      const payload: Record<string, unknown> = {
        voices,
        filtered_by_language: langParse?.success ? langParse.data : null,
      };
      if (supportsModelRaw) {
        payload.filtered_by_model_id = supportsModelRaw;
      }
      if (typeof rawBody.has_more === "boolean") {
        payload.has_more = rawBody.has_more;
      }
      if (typeof rawBody.next_page_token === "string") {
        payload.next_page_token = rawBody.next_page_token;
      }

      return payload;
    }
  );

  app.get(
    "/elevenlabs-avatars",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest) => {
      return await listElevenlabsAvatars(request.customerId!);
    }
  );

  app.post(
    "/elevenlabs-avatars",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = createElAvatarSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      try {
        const row = await createElevenlabsAvatar(request.customerId!, body.data);
        return reply.status(201).send(row);
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          return reply.status(409).send({
            error: "ElevenLabs avatar with this name already exists for this customer",
          });
        }
        throw err;
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/elevenlabs-avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const row = await getElevenlabsAvatar(request.customerId!, id);
      if (!row) return reply.status(404).send({ error: "Not found" });
      return row;
    }
  );

  app.put<{ Params: { id: string } }>(
    "/elevenlabs-avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const body = updateElAvatarSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      if (Object.keys(body.data).length === 0) {
        return reply.status(400).send({ error: "Provide at least one field" });
      }
      try {
        const row = await updateElevenlabsAvatar(
          request.customerId!,
          id,
          body.data
        );
        if (!row) return reply.status(404).send({ error: "Not found" });
        return row;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          return reply.status(409).send({
            error: "ElevenLabs avatar with this name already exists for this customer",
          });
        }
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/elevenlabs-avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const ok = await deleteElevenlabsAvatar(request.customerId!, id);
      if (!ok) return reply.status(404).send({ error: "Not found" });
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/elevenlabs-avatars/:id/set-default",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const row = await setDefaultElevenlabsAvatar(request.customerId!, id);
      if (!row) return reply.status(404).send({ error: "Not found" });
      return row;
    }
  );
}
