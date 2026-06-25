import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { CARTESIA_EMOTIONS } from "../services/cartesia";
import {
  listCartesiaAvatars,
  getCartesiaAvatar,
  createCartesiaAvatar,
  updateCartesiaAvatar,
  deleteCartesiaAvatar,
  setDefaultCartesiaAvatar,
} from "../services/cartesia-avatars";

const bcp47 = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Invalid BCP-47 code (e.g. en-IN)");

const generationConfigSchema = z
  .object({
    speed: z.number().min(0.6).max(1.5).optional(),
    volume: z.number().min(0.5).max(2).optional(),
    emotion: z.string().optional(),
  })
  .strict();

const languageVoiceMapEntry = z
  .object({
    voice_id: z.string().min(1).optional(),
    model_id: z.string().nullable().optional(),
    generation_config: generationConfigSchema.optional(),
  })
  .strict();

const languageVoiceMap = z.record(bcp47, languageVoiceMapEntry);

const createCartesiaAvatarSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  voice_id: z.string().min(1).max(128),
  model_id: z.string().max(128).optional(),
  generation_config: generationConfigSchema.optional(),
  pronunciation_dict_id: z.string().max(128).nullable().optional(),
  legacy_speed: z.enum(["slow", "normal", "fast"]).nullable().optional(),
  is_pvc_voice: z.boolean().optional(),
  language_voice_map: languageVoiceMap.optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

const updateCartesiaAvatarSchema = createCartesiaAvatarSchema.partial().extend({
  name: z.string().min(1).max(120).optional(),
});

function isPgUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === "23505";
}

export async function cartesiaApiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/cartesia-avatars/emotions",
    { preHandler: apiKeyAuth },
    async () => ({ emotions: [...CARTESIA_EMOTIONS] })
  );

  app.get(
    "/cartesia-avatars",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest) => {
      return await listCartesiaAvatars(request.customerId!);
    }
  );

  app.post(
    "/cartesia-avatars",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = createCartesiaAvatarSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      try {
        const row = await createCartesiaAvatar(request.customerId!, body.data);
        return reply.status(201).send(row);
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          return reply.status(409).send({
            error: "Cartesia avatar with this name already exists for this customer",
          });
        }
        throw err;
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/cartesia-avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const row = await getCartesiaAvatar(request.customerId!, id);
      if (!row) return reply.status(404).send({ error: "Not found" });
      return row;
    }
  );

  app.put<{ Params: { id: string } }>(
    "/cartesia-avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const body = updateCartesiaAvatarSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      if (Object.keys(body.data).length === 0) {
        return reply.status(400).send({ error: "Provide at least one field" });
      }
      try {
        const row = await updateCartesiaAvatar(
          request.customerId!,
          id,
          body.data
        );
        if (!row) return reply.status(404).send({ error: "Not found" });
        return row;
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          return reply.status(409).send({
            error: "Cartesia avatar with this name already exists for this customer",
          });
        }
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/cartesia-avatars/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const ok = await deleteCartesiaAvatar(request.customerId!, id);
      if (!ok) return reply.status(404).send({ error: "Not found" });
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { id: string } }>(
    "/cartesia-avatars/:id/set-default",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const row = await setDefaultCartesiaAvatar(request.customerId!, id);
      if (!row) return reply.status(404).send({ error: "Not found" });
      return row;
    }
  );
}
