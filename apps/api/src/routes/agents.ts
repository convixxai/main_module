import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";

// voice_id is a convenience alias for tts_speaker: pick an entry from
// GET /voices and send its `voice_id` here (plus `tts_provider`/`tts_model`
// from that same entry) instead of having to already know the column name.
// Both are accepted; if both are given, tts_speaker wins.
const createAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  system_prompt: z.string().optional().default("You are a helpful assistant."),
  greeting_text: z.string().optional().nullable(),
  error_text: z.string().optional().nullable(),
  tts_provider: z.enum(["sarvam", "elevenlabs", "cartesia"]).optional().nullable(),
  tts_pace: z.number().min(0.5).max(2.0).optional().nullable(),
  tts_pitch: z.number().min(-1).max(1).optional().nullable(),
  tts_loudness: z.number().min(0).max(3).optional().nullable(),
  tts_model: z.string().optional().nullable(),
  tts_speaker: z.string().optional().nullable(),
  voice_id: z.string().optional().nullable(),
  tts_sample_rate: z.number().optional().nullable(),
  // ElevenLabs {stability,similarity_boost,style,speed,use_speaker_boost} or
  // Cartesia {speed,volume,emotion} — applied only when it matches this
  // agent's effective tts_provider (unrecognized keys are ignored at call
  // time, not rejected here, same looseness as customer_settings.tts_humanizer_style).
  tts_voice_settings: z.record(z.string(), z.unknown()).optional().nullable(),
  avatar_id: z.string().uuid().optional().nullable(),
  elevenlabs_avatar_id: z.string().uuid().optional().nullable(),
  cartesia_avatar_id: z.string().uuid().optional().nullable(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
  greeting_text: z.string().optional().nullable(),
  error_text: z.string().optional().nullable(),
  tts_provider: z.enum(["sarvam", "elevenlabs", "cartesia"]).optional().nullable(),
  tts_pace: z.number().min(0.5).max(2.0).optional().nullable(),
  tts_pitch: z.number().min(-1).max(1).optional().nullable(),
  tts_loudness: z.number().min(0).max(3).optional().nullable(),
  tts_model: z.string().optional().nullable(),
  tts_speaker: z.string().optional().nullable(),
  voice_id: z.string().optional().nullable(),
  tts_sample_rate: z.number().optional().nullable(),
  tts_voice_settings: z.record(z.string(), z.unknown()).optional().nullable(),
  avatar_id: z.string().uuid().optional().nullable(),
  elevenlabs_avatar_id: z.string().uuid().optional().nullable(),
  cartesia_avatar_id: z.string().uuid().optional().nullable(),
});

export async function agentRoutes(app: FastifyInstance) {
  app.post(
    "/agents",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = createAgentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const {
        name,
        description,
        system_prompt,
        greeting_text,
        error_text,
        tts_provider,
        tts_pace,
        tts_pitch,
        tts_loudness,
        tts_model,
        tts_speaker,
        voice_id,
        tts_sample_rate,
        tts_voice_settings,
        avatar_id,
        elevenlabs_avatar_id,
        cartesia_avatar_id,
      } = body.data;
      const resolvedTtsSpeaker = tts_speaker ?? voice_id ?? null;

      const result = await pool.query(
        `INSERT INTO agents (
           customer_id, name, description, system_prompt, greeting_text, error_text,
           tts_provider, tts_pace, tts_pitch, tts_loudness, tts_model, tts_speaker, tts_sample_rate,
           tts_voice_settings, avatar_id, elevenlabs_avatar_id, cartesia_avatar_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::jsonb, '{}'::jsonb), $15, $16, $17)
         RETURNING id, customer_id, name, description, system_prompt, greeting_text, error_text,
                   tts_provider, tts_pace, tts_pitch, tts_loudness, tts_model, tts_speaker, tts_sample_rate,
                   tts_voice_settings, avatar_id, elevenlabs_avatar_id, cartesia_avatar_id,
                   is_active, created_at, updated_at`,
        [
          customerId,
          name,
          description,
          system_prompt,
          greeting_text,
          error_text,
          tts_provider ?? null,
          tts_pace,
          tts_pitch,
          tts_loudness,
          tts_model,
          resolvedTtsSpeaker,
          tts_sample_rate,
          tts_voice_settings ? JSON.stringify(tts_voice_settings) : null,
          avatar_id ?? null,
          elevenlabs_avatar_id ?? null,
          cartesia_avatar_id ?? null,
        ]
      );

      return reply.status(201).send(result.rows[0]);
    }
  );

  app.get(
    "/agents",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest) => {
      const customerId = request.customerId!;

      const result = await pool.query(
        `SELECT id, name, description, system_prompt, greeting_text, error_text, tts_provider, tts_pace, tts_pitch, tts_loudness,
                tts_model, tts_speaker, tts_sample_rate, tts_voice_settings,
                avatar_id, elevenlabs_avatar_id, cartesia_avatar_id, is_active, created_at, updated_at
         FROM agents
         WHERE customer_id = $1
         ORDER BY created_at DESC`,
        [customerId]
      );

      return result.rows;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      const result = await pool.query(
        `SELECT id, name, description, system_prompt, greeting_text, error_text, tts_provider, tts_pace, tts_pitch, tts_loudness,
                tts_model, tts_speaker, tts_sample_rate, tts_voice_settings,
                avatar_id, elevenlabs_avatar_id, cartesia_avatar_id, is_active, created_at, updated_at
         FROM agents
         WHERE id = $1 AND customer_id = $2`,
        [id, customerId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      return result.rows[0];
    }
  );

  app.put<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = updateAgentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { id } = request.params as { id: string };
      const {
        name,
        description,
        system_prompt,
        greeting_text,
        error_text,
        tts_provider,
        tts_pace,
        tts_pitch,
        tts_loudness,
        tts_model,
        tts_speaker,
        voice_id,
        tts_sample_rate,
        tts_voice_settings,
        avatar_id,
        elevenlabs_avatar_id,
        cartesia_avatar_id,
      } = body.data;
      // voice_id is a convenience alias for tts_speaker (see createAgentSchema's comment).
      const resolvedTtsSpeaker = tts_speaker !== undefined ? tts_speaker : voice_id;

      if (
        !name &&
        description === undefined &&
        system_prompt === undefined &&
        greeting_text === undefined &&
        error_text === undefined &&
        tts_provider === undefined &&
        tts_pace === undefined &&
        tts_pitch === undefined &&
        tts_loudness === undefined &&
        tts_model === undefined &&
        resolvedTtsSpeaker === undefined &&
        tts_sample_rate === undefined &&
        tts_voice_settings === undefined &&
        avatar_id === undefined &&
        elevenlabs_avatar_id === undefined &&
        cartesia_avatar_id === undefined
      ) {
        return reply
          .status(400)
          .send({ error: "Provide at least one field to update" });
      }

      const existing = await pool.query(
        "SELECT id FROM agents WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );

      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const sets: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (name) {
        sets.push(`name = $${idx++}`);
        values.push(name);
      }
      if (description !== undefined) {
        sets.push(`description = $${idx++}`);
        values.push(description);
      }
      if (system_prompt !== undefined) {
        sets.push(`system_prompt = $${idx++}`);
        values.push(system_prompt);
      }
      if (greeting_text !== undefined) {
        sets.push(`greeting_text = $${idx++}`);
        values.push(greeting_text);
      }
      if (error_text !== undefined) {
        sets.push(`error_text = $${idx++}`);
        values.push(error_text);
      }
      if (tts_provider !== undefined) {
        sets.push(`tts_provider = $${idx++}`);
        values.push(tts_provider);
      }
      if (tts_pace !== undefined) {
        sets.push(`tts_pace = $${idx++}`);
        values.push(tts_pace);
      }
      if (tts_pitch !== undefined) {
        sets.push(`tts_pitch = $${idx++}`);
        values.push(tts_pitch);
      }
      if (tts_loudness !== undefined) {
        sets.push(`tts_loudness = $${idx++}`);
        values.push(tts_loudness);
      }
      if (tts_model !== undefined) {
        sets.push(`tts_model = $${idx++}`);
        values.push(tts_model);
      }
      if (resolvedTtsSpeaker !== undefined) {
        sets.push(`tts_speaker = $${idx++}`);
        values.push(resolvedTtsSpeaker);
      }
      if (tts_sample_rate !== undefined) {
        sets.push(`tts_sample_rate = $${idx++}`);
        values.push(tts_sample_rate);
      }
      if (tts_voice_settings !== undefined) {
        sets.push(`tts_voice_settings = COALESCE($${idx++}::jsonb, '{}'::jsonb)`);
        values.push(tts_voice_settings ? JSON.stringify(tts_voice_settings) : null);
      }
      if (avatar_id !== undefined) {
        sets.push(`avatar_id = $${idx++}`);
        values.push(avatar_id);
      }
      if (elevenlabs_avatar_id !== undefined) {
        sets.push(`elevenlabs_avatar_id = $${idx++}`);
        values.push(elevenlabs_avatar_id);
      }
      if (cartesia_avatar_id !== undefined) {
        sets.push(`cartesia_avatar_id = $${idx++}`);
        values.push(cartesia_avatar_id);
      }

      sets.push(`updated_at = NOW()`);
      values.push(id);
      values.push(customerId);

      const result = await pool.query(
        `UPDATE agents SET ${sets.join(", ")}
         WHERE id = $${idx++} AND customer_id = $${idx}
         RETURNING id, name, description, system_prompt, greeting_text, error_text, tts_provider, tts_pace, tts_pitch, tts_loudness,
                   tts_model, tts_speaker, tts_sample_rate, tts_voice_settings,
                   avatar_id, elevenlabs_avatar_id, cartesia_avatar_id, is_active, created_at, updated_at`,
        values
      );

      return result.rows[0];
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      const result = await pool.query(
        "DELETE FROM agents WHERE id = $1 AND customer_id = $2 RETURNING id",
        [id, customerId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      return { message: "Agent deleted", id };
    }
  );
}
