// ============================================================
// company_phone_numbers DAO — Feature 3 (one company, many phone numbers)
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.3
// Mirrors services/telephony-settings.ts's shape/conventions.
// ============================================================

import { pool } from "../config/db";

export interface CompanyPhoneNumber {
  id: string;
  customer_id: string;
  phone_number: string;
  label: string | null;
  default_agent_id: string | null;
  is_primary: boolean;
  is_enabled: boolean;
  created_at: Date;
  provider_override_id: string | null;
}

export async function getPhoneNumbersForCustomer(
  customerId: string
): Promise<CompanyPhoneNumber[]> {
  const result = await pool.query(
    `SELECT * FROM company_phone_numbers WHERE customer_id = $1 ORDER BY is_primary DESC, created_at ASC`,
    [customerId]
  );
  return result.rows as CompanyPhoneNumber[];
}

export async function resolvePhoneNumberById(
  customerId: string,
  phoneNumberId: string
): Promise<CompanyPhoneNumber | null> {
  const result = await pool.query(
    `SELECT * FROM company_phone_numbers WHERE id = $1 AND customer_id = $2 AND is_enabled = TRUE`,
    [phoneNumberId, customerId]
  );
  return (result.rows[0] as CompanyPhoneNumber) ?? null;
}

/**
 * Inbound routing lookup: given the number a caller dialed, find that
 * number's configured default agent (if any) for this customer. Returns
 * null when there's no matching row or it has no default_agent_id set —
 * callers should fall back to today's "oldest active agent" behavior.
 */
export async function resolveDefaultAgentForNumber(
  customerId: string,
  dialedNumber: string
): Promise<string | null> {
  if (!dialedNumber?.trim()) return null;
  const result = await pool.query(
    `SELECT default_agent_id FROM company_phone_numbers
      WHERE customer_id = $1 AND phone_number = $2 AND is_enabled = TRUE`,
    [customerId, dialedNumber.trim()]
  );
  const agentId = result.rows[0]?.default_agent_id as string | null | undefined;
  return agentId ?? null;
}

export async function createPhoneNumber(params: {
  customerId: string;
  phoneNumber: string;
  label?: string | null;
  defaultAgentId?: string | null;
  isPrimary?: boolean;
  isEnabled?: boolean;
}): Promise<CompanyPhoneNumber> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (params.isPrimary) {
      await client.query(
        `UPDATE company_phone_numbers SET is_primary = FALSE WHERE customer_id = $1`,
        [params.customerId]
      );
    }
    const result = await client.query(
      `INSERT INTO company_phone_numbers (customer_id, phone_number, label, default_agent_id, is_primary, is_enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        params.customerId,
        params.phoneNumber.trim(),
        params.label ?? null,
        params.defaultAgentId ?? null,
        params.isPrimary === true,
        params.isEnabled ?? true,
      ]
    );
    await client.query("COMMIT");
    return result.rows[0] as CompanyPhoneNumber;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updatePhoneNumber(
  customerId: string,
  id: string,
  patch: {
    label?: string | null;
    defaultAgentId?: string | null;
    isEnabled?: boolean;
  }
): Promise<CompanyPhoneNumber | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [id, customerId];

  const addField = (column: string, value: unknown): void => {
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  };
  if (patch.label !== undefined) addField("label", patch.label);
  if (patch.defaultAgentId !== undefined) addField("default_agent_id", patch.defaultAgentId);
  if (patch.isEnabled !== undefined) addField("is_enabled", patch.isEnabled);

  if (setClauses.length === 0) {
    return resolvePhoneNumberByIdIgnoringEnabled(customerId, id);
  }

  const result = await pool.query(
    `UPDATE company_phone_numbers SET ${setClauses.join(", ")}
      WHERE id = $1 AND customer_id = $2
      RETURNING *`,
    values
  );
  return (result.rows[0] as CompanyPhoneNumber) ?? null;
}

async function resolvePhoneNumberByIdIgnoringEnabled(
  customerId: string,
  id: string
): Promise<CompanyPhoneNumber | null> {
  const result = await pool.query(
    `SELECT * FROM company_phone_numbers WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return (result.rows[0] as CompanyPhoneNumber) ?? null;
}

/** Set this number as the customer's primary, unsetting any other primary first. Returns false if the number doesn't belong to this customer. */
export async function setPrimaryPhoneNumber(customerId: string, id: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      `SELECT id FROM company_phone_numbers WHERE id = $1 AND customer_id = $2`,
      [id, customerId]
    );
    if (owned.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`UPDATE company_phone_numbers SET is_primary = FALSE WHERE customer_id = $1`, [
      customerId,
    ]);
    await client.query(`UPDATE company_phone_numbers SET is_primary = TRUE WHERE id = $1`, [id]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Returns false if the number doesn't belong to this customer (nothing deleted). */
export async function deletePhoneNumber(customerId: string, id: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM company_phone_numbers WHERE id = $1 AND customer_id = $2`,
    [id, customerId]
  );
  return (result.rowCount ?? 0) > 0;
}
