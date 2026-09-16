// ============================================================
// One-time (but safely re-runnable) correction: re-detects each existing
// kb_entries row's actual authored language from its own question text
// (same detectSourceLanguage logic the admin routes now use going forward)
// and fixes source_language_code where it was wrong - specifically, entries
// typed directly in Marathi/Hindi that got the 'en-IN' default before this
// fix existed. Only updates rows where detection disagrees with the current
// value; leaves everything else untouched.
//
// Usage (from apps/api): npx ts-node scripts/fix-kb-source-languages.ts <customerId>
// Defaults to the Ganeshotsav customer id if no argument is given.
// ============================================================

import { pool } from "../src/config/db";
import { getCustomerSettings } from "../src/services/customer-settings";
import { inferLanguageFromTranscript } from "../src/services/voice-language-infer";

const DEFAULT_CUSTOMER_ID = "97752ef1-eb4f-4ebb-a77f-0613fe3a424b";
const FALLBACK = "en-IN";

async function main(): Promise<void> {
  const customerId = process.argv[2] || DEFAULT_CUSTOMER_ID;
  const settings = await getCustomerSettings(customerId);
  const allowed = settings?.allowed_language_codes?.length ? settings.allowed_language_codes : [FALLBACK];

  const rows = await pool.query<{ id: string; question: string; source_language_code: string }>(
    `SELECT id, question, source_language_code FROM kb_entries WHERE customer_id = $1`,
    [customerId]
  );

  let fixed = 0;
  for (const row of rows.rows) {
    const detected = inferLanguageFromTranscript(row.question, allowed, FALLBACK) ?? FALLBACK;
    if (detected !== row.source_language_code) {
      await pool.query(`UPDATE kb_entries SET source_language_code = $1 WHERE id = $2`, [detected, row.id]);
      console.log(`  fixed ${row.id}: ${row.source_language_code} -> ${detected}  ("${row.question.slice(0, 60)}")`);
      fixed++;
    }
  }

  console.log(`\nDone. ${rows.rows.length} entries checked, ${fixed} corrected.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
