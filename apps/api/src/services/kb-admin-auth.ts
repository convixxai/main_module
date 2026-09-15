// ============================================================
// Auth for the temporary, per-customer KB admin web pages
// (e.g. the Ganeshotsav project page). One row in `kb_admin_users` per
// login identity, scoped to a single customer_id. Single active session:
// logging in anywhere overwrites `session_token`, which immediately
// invalidates whatever browser/window was using the previous token.
// ============================================================

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../config/db";

const BCRYPT_ROUNDS = 12;

export interface KbAdminUser {
  id: string;
  customerId: string;
  username: string;
}

export async function hashKbAdminPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Verifies username/password and that the matched account belongs to the expected customer. */
export async function verifyKbAdminLogin(
  expectedCustomerId: string,
  username: string,
  password: string
): Promise<KbAdminUser | null> {
  const r = await pool.query(
    `SELECT id, customer_id, username, password_hash FROM kb_admin_users WHERE username = $1`,
    [username]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (row.customer_id !== expectedCustomerId) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
  return { id: row.id, customerId: row.customer_id, username: row.username };
}

/** Issues a fresh session token, replacing (and thereby invalidating) any prior one. */
export async function createKbAdminSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `UPDATE kb_admin_users SET session_token = $1, session_created_at = now() WHERE id = $2`,
    [token, userId]
  );
  return token;
}

export async function clearKbAdminSession(userId: string): Promise<void> {
  await pool.query(
    `UPDATE kb_admin_users SET session_token = NULL, session_created_at = NULL WHERE id = $1`,
    [userId]
  );
}

/** Validates a session token against a specific customer's account, the token must be the CURRENT one. */
export async function validateKbAdminSession(
  customerId: string,
  token: string | null
): Promise<KbAdminUser | null> {
  if (!token) return null;
  const r = await pool.query(
    `SELECT id, customer_id, username FROM kb_admin_users WHERE customer_id = $1 AND session_token = $2`,
    [customerId, token]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { id: row.id, customerId: row.customer_id, username: row.username };
}
