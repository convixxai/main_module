// ============================================================
// Safely re-runnable backfill: fans out kb_entries rows for a customer into
// kb_entry_translations for all of that customer's currently
// allowed_language_codes. Purely additive - does not touch kb_entries or
// any live query path. See migration 015 and services/kb-translation.ts.
//
// Only translates entries that DON'T already have a full, successful set of
// translations - already-translated entries are skipped entirely (no
// Sarvam calls, no cost) - so re-running this after adding a few new
// entries only pays for those new entries, not the whole KB again. Safe to
// run as often as you like for exactly that reason.
//
// Usage (from apps/api): npx ts-node scripts/backfill-kb-translations.ts <customerId>
// Defaults to the Ganeshotsav customer id if no argument is given.
// ============================================================

import { pool } from "../src/config/db";
import { getCustomerSettings } from "../src/services/customer-settings";
import { backfillCustomerKbTranslations } from "../src/services/kb-translation";

const DEFAULT_CUSTOMER_ID = "97752ef1-eb4f-4ebb-a77f-0613fe3a424b";

async function main(): Promise<void> {
  const customerId = process.argv[2] || DEFAULT_CUSTOMER_ID;
  const settings = await getCustomerSettings(customerId);
  if (!settings) {
    console.error(`No customer_settings row found for customer_id ${customerId}`);
    process.exit(1);
  }
  const allowed = settings.allowed_language_codes?.length ? settings.allowed_language_codes : ["en-IN"];
  console.log(`Backfilling KB translations for customer ${customerId}`);
  console.log(`Allowed languages: ${allowed.join(", ")}`);

  const results = await backfillCustomerKbTranslations(customerId, allowed, {
    concurrency: 4,
    onProgress: (done, total) => {
      process.stdout.write(`\r  ${done}/${total} entries processed`);
    },
  });
  process.stdout.write("\n");

  let failures = 0;
  for (const r of results) {
    for (const lang of r.results) {
      if (!lang.ok) {
        failures += 1;
        console.warn(`  FAILED  entry ${r.entryId} -> ${lang.languageCode}  ("${r.question.slice(0, 60)}")`);
      }
    }
  }

  console.log(`\nDone. ${results.length} entries processed, ${failures} language-translation failures.`);
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
