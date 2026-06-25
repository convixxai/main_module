import { pool } from "../config/db";
import type { CartesiaGenerationConfig } from "./cartesia";

export type CartesiaAvatarRow = {
  id: string;
  customer_id: string;
  name: string;
  description: string;
  voice_id: string;
  model_id: string;
  generation_config: CartesiaGenerationConfig;
  pronunciation_dict_id: string | null;
  legacy_speed: string | null;
  is_pvc_voice: boolean;
  language_voice_map: unknown;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

const SELECT_COLS = `id, customer_id, name, description, voice_id, model_id, generation_config,
  pronunciation_dict_id, legacy_speed, is_pvc_voice, language_voice_map,
  is_default, is_active, created_at, updated_at`;

export async function listCartesiaAvatars(
  customerId: string
): Promise<CartesiaAvatarRow[]> {
  const r = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM cartesia_avatars
     WHERE customer_id = $1
     ORDER BY is_default DESC, name ASC`,
    [customerId]
  );
  return r.rows as CartesiaAvatarRow[];
}

export async function getCartesiaAvatar(
  customerId: string,
  id: string
): Promise<CartesiaAvatarRow | null> {
  const r = await pool.query(
    `SELECT ${SELECT_COLS}
     FROM cartesia_avatars
     WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return r.rows.length ? (r.rows[0] as CartesiaAvatarRow) : null;
}

export type CreateCartesiaAvatarInput = {
  name: string;
  description?: string;
  voice_id: string;
  model_id?: string;
  generation_config?: CartesiaGenerationConfig;
  pronunciation_dict_id?: string | null;
  legacy_speed?: "slow" | "normal" | "fast" | null;
  is_pvc_voice?: boolean;
  language_voice_map?: unknown;
  is_default?: boolean;
  is_active?: boolean;
};

export async function createCartesiaAvatar(
  customerId: string,
  input: CreateCartesiaAvatarInput
): Promise<CartesiaAvatarRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.is_default === true) {
      await client.query(
        `UPDATE cartesia_avatars SET is_default = FALSE WHERE customer_id = $1`,
        [customerId]
      );
    }
    const r = await client.query(
      `INSERT INTO cartesia_avatars (
         customer_id, name, description, voice_id, model_id, generation_config,
         pronunciation_dict_id, legacy_speed, is_pvc_voice, language_voice_map,
         is_default, is_active
       ) VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{"speed":1,"volume":1,"emotion":"neutral"}'::jsonb),
                 $7, $8, $9, COALESCE($10::jsonb, '{}'::jsonb), $11, $12)
       RETURNING ${SELECT_COLS}`,
      [
        customerId,
        input.name,
        input.description ?? "",
        input.voice_id,
        input.model_id ?? "sonic-3.5",
        JSON.stringify(input.generation_config ?? { speed: 1, volume: 1, emotion: "neutral" }),
        input.pronunciation_dict_id ?? null,
        input.legacy_speed ?? null,
        input.is_pvc_voice === true,
        JSON.stringify(input.language_voice_map ?? {}),
        input.is_default === true,
        input.is_active !== false,
      ]
    );
    await client.query("COMMIT");
    return r.rows[0] as CartesiaAvatarRow;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export type UpdateCartesiaAvatarInput = Partial<CreateCartesiaAvatarInput>;

export async function updateCartesiaAvatar(
  customerId: string,
  id: string,
  patch: UpdateCartesiaAvatarInput
): Promise<CartesiaAvatarRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(patch.description);
  }
  if (patch.voice_id !== undefined) {
    sets.push(`voice_id = $${i++}`);
    values.push(patch.voice_id);
  }
  if (patch.model_id !== undefined) {
    sets.push(`model_id = $${i++}`);
    values.push(patch.model_id);
  }
  if (patch.generation_config !== undefined) {
    sets.push(`generation_config = $${i++}::jsonb`);
    values.push(JSON.stringify(patch.generation_config));
  }
  if (patch.pronunciation_dict_id !== undefined) {
    sets.push(`pronunciation_dict_id = $${i++}`);
    values.push(patch.pronunciation_dict_id);
  }
  if (patch.legacy_speed !== undefined) {
    sets.push(`legacy_speed = $${i++}`);
    values.push(patch.legacy_speed);
  }
  if (patch.is_pvc_voice !== undefined) {
    sets.push(`is_pvc_voice = $${i++}`);
    values.push(patch.is_pvc_voice);
  }
  if (patch.language_voice_map !== undefined) {
    sets.push(`language_voice_map = $${i++}::jsonb`);
    values.push(JSON.stringify(patch.language_voice_map));
  }
  if (patch.is_active !== undefined) {
    sets.push(`is_active = $${i++}`);
    values.push(patch.is_active);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (patch.is_default === true) {
      await client.query(
        `UPDATE cartesia_avatars SET is_default = FALSE WHERE customer_id = $1`,
        [customerId]
      );
    }
    if (patch.is_default !== undefined) {
      sets.push(`is_default = $${i++}`);
      values.push(patch.is_default);
    }

    if (sets.length === 0) {
      await client.query("ROLLBACK");
      return getCartesiaAvatar(customerId, id);
    }

    values.push(id, customerId);
    const r = await client.query(
      `UPDATE cartesia_avatars SET ${sets.join(", ")}
       WHERE id = $${i++} AND customer_id = $${i}
       RETURNING ${SELECT_COLS}`,
      values
    );
    await client.query("COMMIT");
    return r.rows.length ? (r.rows[0] as CartesiaAvatarRow) : null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteCartesiaAvatar(
  customerId: string,
  id: string
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM cartesia_avatars WHERE id = $1 AND customer_id = $2 RETURNING id`,
    [id, customerId]
  );
  return r.rows.length > 0;
}

export async function setDefaultCartesiaAvatar(
  customerId: string,
  id: string
): Promise<CartesiaAvatarRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE cartesia_avatars SET is_default = FALSE WHERE customer_id = $1`,
      [customerId]
    );
    const r = await client.query(
      `UPDATE cartesia_avatars SET is_default = TRUE
       WHERE id = $1 AND customer_id = $2
       RETURNING ${SELECT_COLS}`,
      [id, customerId]
    );
    await client.query("COMMIT");
    return r.rows.length ? (r.rows[0] as CartesiaAvatarRow) : null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
