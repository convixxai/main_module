import { pool } from "../config/db";

export type ElevenlabsAvatarRow = {
  id: string;
  customer_id: string;
  name: string;
  description: string;
  voice_id: string;
  model_id: string | null;
  voice_settings: unknown;
  language_voice_map: unknown;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export async function listElevenlabsAvatars(
  customerId: string
): Promise<ElevenlabsAvatarRow[]> {
  const r = await pool.query(
    `SELECT id, customer_id, name, description, voice_id, model_id, voice_settings,
            language_voice_map, is_default, is_active, created_at, updated_at
     FROM elevenlabs_avatars
     WHERE customer_id = $1
     ORDER BY is_default DESC, name ASC`,
    [customerId]
  );
  return r.rows as ElevenlabsAvatarRow[];
}

export async function getElevenlabsAvatar(
  customerId: string,
  id: string
): Promise<ElevenlabsAvatarRow | null> {
  const r = await pool.query(
    `SELECT id, customer_id, name, description, voice_id, model_id, voice_settings,
            language_voice_map, is_default, is_active, created_at, updated_at
     FROM elevenlabs_avatars
     WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return r.rows.length ? (r.rows[0] as ElevenlabsAvatarRow) : null;
}

export type CreateElevenlabsAvatarInput = {
  name: string;
  description?: string;
  voice_id: string;
  model_id?: string | null;
  voice_settings?: unknown;
  language_voice_map?: unknown;
  is_default?: boolean;
  is_active?: boolean;
};

export async function createElevenlabsAvatar(
  customerId: string,
  input: CreateElevenlabsAvatarInput
): Promise<ElevenlabsAvatarRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.is_default === true) {
      await client.query(
        `UPDATE elevenlabs_avatars SET is_default = FALSE WHERE customer_id = $1`,
        [customerId]
      );
    }
    const r = await client.query(
      `INSERT INTO elevenlabs_avatars (
         customer_id, name, description, voice_id, model_id, voice_settings, language_voice_map,
         is_default, is_active
       ) VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), COALESCE($7::jsonb, '{}'::jsonb), $8, $9)
       RETURNING id, customer_id, name, description, voice_id, model_id, voice_settings,
                 language_voice_map, is_default, is_active, created_at, updated_at`,
      [
        customerId,
        input.name,
        input.description ?? "",
        input.voice_id,
        input.model_id ?? null,
        JSON.stringify(input.voice_settings ?? {}),
        JSON.stringify(input.language_voice_map ?? {}),
        input.is_default === true,
        input.is_active !== false,
      ]
    );
    await client.query("COMMIT");
    return r.rows[0] as ElevenlabsAvatarRow;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export type UpdateElevenlabsAvatarInput = Partial<CreateElevenlabsAvatarInput>;

export async function updateElevenlabsAvatar(
  customerId: string,
  id: string,
  patch: UpdateElevenlabsAvatarInput
): Promise<ElevenlabsAvatarRow | null> {
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
  if (patch.voice_settings !== undefined) {
    sets.push(`voice_settings = $${i++}::jsonb`);
    values.push(JSON.stringify(patch.voice_settings));
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
        `UPDATE elevenlabs_avatars SET is_default = FALSE WHERE customer_id = $1`,
        [customerId]
      );
    }
    if (patch.is_default !== undefined) {
      sets.push(`is_default = $${i++}`);
      values.push(patch.is_default);
    }

    if (sets.length === 0) {
      await client.query("ROLLBACK");
      return getElevenlabsAvatar(customerId, id);
    }

    values.push(id, customerId);
    const r = await client.query(
      `UPDATE elevenlabs_avatars SET ${sets.join(", ")}
       WHERE id = $${i++} AND customer_id = $${i}
       RETURNING id, customer_id, name, description, voice_id, model_id, voice_settings,
                 language_voice_map, is_default, is_active, created_at, updated_at`,
      values
    );
    await client.query("COMMIT");
    return r.rows.length ? (r.rows[0] as ElevenlabsAvatarRow) : null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteElevenlabsAvatar(
  customerId: string,
  id: string
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM elevenlabs_avatars WHERE id = $1 AND customer_id = $2 RETURNING id`,
    [id, customerId]
  );
  return r.rows.length > 0;
}

export async function setDefaultElevenlabsAvatar(
  customerId: string,
  id: string
): Promise<ElevenlabsAvatarRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE elevenlabs_avatars SET is_default = FALSE WHERE customer_id = $1`,
      [customerId]
    );
    const r = await client.query(
      `UPDATE elevenlabs_avatars SET is_default = TRUE
       WHERE id = $1 AND customer_id = $2
       RETURNING id, customer_id, name, description, voice_id, model_id, voice_settings,
                 language_voice_map, is_default, is_active, created_at, updated_at`,
      [id, customerId]
    );
    await client.query("COMMIT");
    return r.rows.length ? (r.rows[0] as ElevenlabsAvatarRow) : null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
