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

/** Voices from ElevenLabs `labels.language` are often lowercase ISO (e.g. "hi", "en"). */
function voiceMatchesLanguageFilter(
  voice: Record<string, unknown>,
  want: string
): boolean {
  const w = want.trim().toLowerCase();
  const primary = w.split("-")[0] || w;
  const labels = voice.labels as Record<string, unknown> | undefined;
  const lang =
    typeof labels?.language === "string" ? labels.language.toLowerCase() : "";
  if (lang && (lang === primary || lang === w || w.startsWith(lang))) {
    return true;
  }
  const name = typeof voice.name === "string" ? voice.name.toLowerCase() : "";
  return name.includes(primary);
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

      let listed: { status: number; body: unknown };
      try {
        listed = await elevenLabsListVoices();
      } catch (err) {
        request.log.error({ err }, "ElevenLabs list voices failed");
        return reply.status(502).send({ error: "ElevenLabs request failed" });
      }

      if (listed.status !== 200) {
        return reply.status(listed.status).send(listed.body);
      }

      const body = listed.body as { voices?: unknown[] };
      let voices = Array.isArray(body.voices) ? body.voices : [];
      if (langParse?.success) {
        const tag = langParse.data;
        voices = voices.filter(
          (v) =>
            v &&
            typeof v === "object" &&
            voiceMatchesLanguageFilter(v as Record<string, unknown>, tag)
        );
      }

      return {
        voices,
        filtered_by_language: langParse?.success ? langParse.data : null,
      };
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
