// ============================================================
// Backfill script: company_telephony_settings.credentials_enc
//
// Migration 010 creates one company_telephony_settings row per existing
// customer_exotel_settings row (provider_id='exotel'), but leaves
// credentials_enc NULL because AES-256-GCM encryption needs the Node
// crypto helper (services/crypto.ts) and its key from app env — SQL alone
// can't do that. This script does the encryption step.
//
// Idempotent: only touches rows where credentials_enc IS NULL, so it's
// safe to re-run (e.g. after a customer's Exotel settings are next edited
// through the normal encrypted path, this script simply has nothing left
// to do for that row).
//
// Usage (from apps/api):
//   npx ts-node scripts/backfill-telephony-credentials.ts
//   npx ts-node scripts/backfill-telephony-credentials.ts --dry-run
//
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5
// infra/postgres/migrations/010_telephony_provider_adapter.sql
// ============================================================

import { pool } from "../src/config/db";
import { encrypt } from "../src/services/crypto";

interface ExotelCredentialRow {
  customer_id: string;
  exotel_account_sid: string | null;
  exotel_app_id: string | null;
  exotel_subdomain: string | null;
  exotel_api_key: string | null;
  exotel_api_token: string | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const { rows } = await pool.query<ExotelCredentialRow>(
    `SELECT ces.customer_id, ces.exotel_account_sid, ces.exotel_app_id,
            ces.exotel_subdomain, ces.exotel_api_key, ces.exotel_api_token
       FROM customer_exotel_settings ces
       JOIN company_telephony_settings cts ON cts.customer_id = ces.customer_id
      WHERE cts.provider_id = 'exotel'
        AND cts.credentials_enc IS NULL`
  );

  console.log(`Found ${rows.length} company_telephony_settings row(s) needing a credentials_enc backfill.`);

  let updated = 0;
  for (const row of rows) {
    const credentials = {
      account_sid: row.exotel_account_sid,
      app_id: row.exotel_app_id,
      subdomain: row.exotel_subdomain,
      api_key: row.exotel_api_key,
      api_token: row.exotel_api_token,
    };

    if (dryRun) {
      console.log(`[dry-run] would encrypt+set credentials_enc for customer_id=${row.customer_id}`);
      continue;
    }

    const encrypted = encrypt(JSON.stringify(credentials));
    await pool.query(
      `UPDATE company_telephony_settings
          SET credentials_enc = $1
        WHERE customer_id = $2 AND provider_id = 'exotel' AND credentials_enc IS NULL`,
      [encrypted, row.customer_id]
    );
    updated += 1;
  }

  console.log(dryRun ? "Dry run complete, no rows changed." : `Backfilled credentials_enc for ${updated} row(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
