// ============================================================
// Avatars DAO — per-customer reusable voice personas.
//
// An avatar bundles TTS provider + model + speaker + pace/pitch/loudness
// with an optional per-language override map (language_voice_map).
// Agents may reference an avatar via agents.avatar_id.
// ============================================================

import { pool } from "../config/db";

export type TtsProvider = "sarvam" | "elevenlabs";

export interface LanguageVoiceMapEntry {
  tts_provider?: TtsProvider;
  tts_model?: string | null;
  tts_speaker?: string | null;
  tts_pace?: number | null;
  tts_pitch?: number | null;
  tts_loudness?: number | null;
  tts_sample_rate?: number | null;
}

export interface Avatar {
  id: string;
  customer_id: string;
  name: string;
  description: string;
  tone: string | null;

  tts_provider: TtsProvider;
  tts_model: string | null;
  tts_speaker: string | null;
  tts_pace: number | null;
  tts_pitch: number | null;
  tts_loudness: number | null;
  tts_sample_rate: number | null;

  language_voice_map: Record<string, LanguageVoiceMapEntry>;

  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAvatarInput {
  name: string;
  description?: string;
  tone?: string | null;
  tts_provider?: TtsProvider;
  tts_model?: string | null;
  tts_speaker?: string | null;
  tts_pace?: number | null;
  tts_pitch?: number | null;
  tts_loudness?: number | null;
  tts_sample_rate?: number | null;
  language_voice_map?: Record<string, LanguageVoiceMapEntry>;
  is_default?: boolean;
  is_active?: boolean;
}

export type UpdateAvatarInput = Partial<CreateAvatarInput>;

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize(row: Record<string, unknown>): Avatar {
  return {
    ...(row as unknown as Avatar),
    tts_pace: toNumberOrNull(row.tts_pace),
    tts_pitch: toNumberOrNull(row.tts_pitch),
    tts_loudness: toNumberOrNull(row.tts_loudness),
    tts_sample_rate: toNumberOrNull(row.tts_sample_rate),
  };
}

const SELECT_COLS = `id, customer_id, name, description, tone,
  tts_provider, tts_model, tts_speaker,
  tts_pace, tts_pitch, tts_loudness, tts_sample_rate,
  language_voice_map, is_default, is_active,
  created_at, updated_at`;

export async function listAvatars(customerId: string): Promise<Avatar[]> {
  const result = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM avatars
     WHERE customer_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [customerId]
  );
  return result.rows.map((r: Record<string, unknown>) => normalize(r));
}

export async function getAvatar(
  customerId: string,
  avatarId: string
): Promise<Avatar | null> {
  const result = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM avatars
     WHERE customer_id = $1 AND id = $2`,
    [customerId, avatarId]
  );
  return result.rows.length === 0
    ? null
    : normalize(result.rows[0] as Record<string, unknown>);
}

export async function getDefaultAvatar(
  customerId: string
): Promise<Avatar | null> {
  const result = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM avatars
     WHERE customer_id = $1 AND is_default = TRUE
     LIMIT 1`,
    [customerId]
  );
  return result.rows.length === 0
    ? null
    : normalize(result.rows[0] as Record<string, unknown>);
}

/**
 * Create an avatar. If `is_default = true`, any existing default is cleared
 * atomically so the uniq_default_avatar_per_customer index is respected.
 */
export async function createAvatar(
  customerId: string,
  input: CreateAvatarInput
): Promise<Avatar> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (input.is_default) {
      await client.query(
        `UPDATE avatars SET is_default = FALSE
         WHERE customer_id = $1 AND is_default = TRUE`,
        [customerId]
      );
    }

    const result = await client.query(
      `INSERT INTO avatars (
        customer_id, name, description, tone,
        tts_provider, tts_model, tts_speaker,
        tts_pace, tts_pitch, tts_loudness, tts_sample_rate,
        language_voice_map, is_default, is_active
      ) VALUES (
        $1, $2, COALESCE($3, ''), $4,
        COALESCE($5, 'sarvam'), $6, $7,
        $8, $9, $10, $11,
        COALESCE($12::jsonb, '{}'::jsonb),
        COALESCE($13, FALSE),
        COALESCE($14, TRUE)
      )
      RETURNING ${SELECT_COLS}`,
      [
        customerId,
        input.name,
        input.description ?? null,
        input.tone ?? null,
        input.tts_provider ?? null,
        input.tts_model ?? null,
        input.tts_speaker ?? null,
        input.tts_pace ?? null,
        input.tts_pitch ?? null,
        input.tts_loudness ?? null,
        input.tts_sample_rate ?? null,
        input.language_voice_map ? JSON.stringify(input.language_voice_map) : null,
        input.is_default ?? null,
        input.is_active ?? null,
      ]
    );

    await client.query("COMMIT");
    return normalize(result.rows[0] as Record<string, unknown>);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Partial update. Only the keys present in `input` are written.
 * Toggling `is_default` to true demotes any previous default atomically.
 */
export async function updateAvatar(
  customerId: string,
  avatarId: string,
  input: UpdateAvatarInput
): Promise<Avatar | null> {
  const allowed: (keyof UpdateAvatarInput)[] = [
    "name",
    "description",
    "tone",
    "tts_provider",
    "tts_model",
    "tts_speaker",
    "tts_pace",
    "tts_pitch",
    "tts_loudness",
    "tts_sample_rate",
    "language_voice_map",
    "is_default",
    "is_active",
  ];

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const key of allowed) {
    if (!(key in input)) continue;
    const v = (input as Record<string, unknown>)[key];
    if (key === "language_voice_map") {
      sets.push(`${key} = $${idx++}::jsonb`);
      values.push(v == null ? "{}" : JSON.stringify(v));
    } else {
      sets.push(`${key} = $${idx++}`);
      values.push(v ?? null);
    }
  }

  if (sets.length === 0) {
    return await getAvatar(customerId, avatarId);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (input.is_default === true) {
      await client.query(
        `UPDATE avatars SET is_default = FALSE
         WHERE customer_id = $1 AND is_default = TRUE AND id <> $2`,
        [customerId, avatarId]
      );
    }

    values.push(avatarId, customerId);
    const sql = `UPDATE avatars SET ${sets.join(", ")}
                 WHERE id = $${idx++} AND customer_id = $${idx}
                 RETURNING ${SELECT_COLS}`;
    const result = await client.query(sql, values);

    await client.query("COMMIT");
    return result.rows.length === 0
      ? null
      : normalize(result.rows[0] as Record<string, unknown>);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAvatar(
  customerId: string,
  avatarId: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM avatars WHERE id = $1 AND customer_id = $2 RETURNING id`,
    [avatarId, customerId]
  );
  return result.rows.length > 0;
}

/** Atomically set `avatarId` as the default avatar for this customer. */
export async function setDefaultAvatar(
  customerId: string,
  avatarId: string
): Promise<Avatar | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE avatars SET is_default = FALSE
       WHERE customer_id = $1 AND is_default = TRUE AND id <> $2`,
      [customerId, avatarId]
    );
    const result = await client.query(
      `UPDATE avatars SET is_default = TRUE
       WHERE id = $1 AND customer_id = $2
       RETURNING ${SELECT_COLS}`,
      [avatarId, customerId]
    );
    await client.query("COMMIT");
    return result.rows.length === 0
      ? null
      : normalize(result.rows[0] as Record<string, unknown>);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
