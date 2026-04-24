// ============================================================
// Avatars — per-customer reusable voice personas.
// Scoped by x-api-key (tenant-editable).
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import {
  listAvatars,
  getAvatar,
  createAvatar,
  updateAvatar,
  deleteAvatar,
  setDefaultAvatar,
} from "../services/avatars";

const bcp47 = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Invalid BCP-47 code (e.g. en-IN)");

const provider = z.enum(["sarvam", "elevenlabs"]);

const languageVoiceMapEntry = z
  .object({
    tts_provider: provider.optional(),
    tts_model: z.string().nullable().optional(),
    tts_speaker: z.string().nullable().optional(),
    tts_pace: z.number().min(0.5).max(2.0).nullable().optional(),
    tts_pitch: z.number().nullable().optional(),
    tts_loudness: z.number().nullable().optional(),
    tts_sample_rate: z.number().int().positive().nullable().optional(),
  })
  .strict();

const languageVoiceMap = z.record(bcp47, languageVoiceMapEntry);

const createAvatarSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  tone: z.string().max(60).nullable().optional(),
  tts_provider: provider.optional(),
  tts_model: z.string().nullable().optional(),
  tts_speaker: z.string().nullable().optional(),
  tts_pace: z.number().min(0.5).max(2.0).nullable().optional(),
  tts_pitch: z.number().nullable().optional(),
  tts_loudness: z.number().nullable().optional(),
  tts_sample_rate: z.number().int().positive().nullable().optional(),
  language_voice_map: languageVoiceMap.optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

const updateAvatarSchema = createAvatarSchema.partial().extend({
  name: z.string().min(1).max(120).optional(),
});

function isPgUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === "23505";
}

export async function avatarRoutes(app: FastifyInstance): Promise<void> {
  /** List avatars for the authenticated customer. */
  app.get(
    "/avatars",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest) => {
      const customerId = request.customerId!;
      return await listAvatars(customerId);
    }
  );

  /** Create an avatar. */
  app.post(
    "/avatars",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = createAvatarSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      try {
        const avatar = await createAvatar(request.customerId!, body.data);
        return reply.status(201).send(avatar);
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          return reply.status(409).send({
            error: "Avatar with this name already exists for this customer",
          });
        }
        throw err;
      }
    }
  );

  /** Get one avatar by id. */
  app.get<{ Params: { id: string } }>(
    "/avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const avatar = await getAvatar(request.customerId!, id);
      if (!avatar) {
        return reply.status(404).send({ error: "Avatar not found" });
      }
      return avatar;
    }
  );

  /** Partial update. */
  app.put<{ Params: { id: string } }>(
    "/avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = updateAvatarSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      const { id } = request.params as { id: string };
      try {
        const avatar = await updateAvatar(
          request.customerId!,
          id,
          body.data
        );
        if (!avatar) {
          return reply.status(404).send({ error: "Avatar not found" });
        }
        return avatar;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          return reply.status(409).send({
            error: "Avatar with this name already exists for this customer",
          });
        }
        throw err;
      }
    }
  );

  /** Mark an avatar as the default for this customer (demotes any previous default). */
  app.post<{ Params: { id: string } }>(
    "/avatars/:id/set-default",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const avatar = await setDefaultAvatar(request.customerId!, id);
      if (!avatar) {
        return reply.status(404).send({ error: "Avatar not found" });
      }
      return avatar;
    }
  );

  /** Delete an avatar. Agents referencing it have avatar_id set to NULL via FK. */
  app.delete<{ Params: { id: string } }>(
    "/avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await deleteAvatar(request.customerId!, id);
      if (!deleted) {
        return reply.status(404).send({ error: "Avatar not found" });
      }
      return { message: "Avatar deleted", id };
    }
  );
}
