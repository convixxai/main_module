// ============================================================
// Standalone verification for Feature 3 (one company, many phone numbers):
// exercises the company-phone-numbers.ts service against the live dev DB,
// using the existing temp Cartesia-test-console customer (NOT either real
// customer) so nothing here touches real customer data. Cleans up after
// itself (deletes the test numbers it creates).
//
// Usage (from apps/api): npx ts-node scripts/verify-company-phone-numbers.ts
// ============================================================

import { pool } from "./../src/config/db";
import {
  getPhoneNumbersForCustomer,
  resolvePhoneNumberById,
  resolveDefaultAgentForNumber,
  createPhoneNumber,
  updatePhoneNumber,
  setPrimaryPhoneNumber,
  deletePhoneNumber,
} from "../src/services/company-phone-numbers";

const MARKER_NAME = "__TEMP_CARTESIA_VOICE_TEST_CONSOLE__";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`, detail ?? "");
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  const customerRow = await pool.query(`SELECT id FROM customers WHERE name = $1`, [MARKER_NAME]);
  if (customerRow.rows.length === 0) {
    console.error("Temp test customer not found — run create-temp-voice-test-customer.ts first.");
    process.exit(1);
  }
  const customerId = customerRow.rows[0].id as string;
  const agentRow = await pool.query(`SELECT id FROM agents WHERE customer_id = $1 LIMIT 1`, [customerId]);
  const agentId = agentRow.rows[0]?.id as string | undefined;
  console.log(`Using temp customer ${customerId}, agent ${agentId}`);

  const testNumberA = "+911234500001";
  const testNumberB = "+911234500002";

  // Clean up any leftovers from a previous failed run
  const existing = await getPhoneNumbersForCustomer(customerId);
  for (const n of existing) {
    if (n.phone_number === testNumberA || n.phone_number === testNumberB) {
      await deletePhoneNumber(customerId, n.id);
    }
  }

  section("createPhoneNumber");
  const created = await createPhoneNumber({
    customerId,
    phoneNumber: testNumberA,
    label: "Test line A",
    isPrimary: true,
  });
  check("created row has expected fields", created.phone_number === testNumberA && created.is_primary === true, created);

  const createdB = await createPhoneNumber({
    customerId,
    phoneNumber: testNumberB,
    label: "Test line B",
    defaultAgentId: agentId ?? null,
  });
  check("second number created, not primary by default", createdB.is_primary === false, createdB);

  section("getPhoneNumbersForCustomer");
  const list = await getPhoneNumbersForCustomer(customerId);
  check("both test numbers present, primary first", list.length >= 2 && list[0].is_primary === true, list);

  section("resolvePhoneNumberById");
  const resolved = await resolvePhoneNumberById(customerId, createdB.id);
  check("resolves the correct row", resolved?.phone_number === testNumberB, resolved);
  const resolvedWrongCustomer = await resolvePhoneNumberById("00000000-0000-0000-0000-000000000000", createdB.id);
  check("does not resolve for a different customer_id", resolvedWrongCustomer === null, resolvedWrongCustomer);

  section("resolveDefaultAgentForNumber");
  if (agentId) {
    const resolvedAgent = await resolveDefaultAgentForNumber(customerId, testNumberB);
    check("resolves the configured default_agent_id for number B", resolvedAgent === agentId, resolvedAgent);
  } else {
    console.log("  SKIP no agent on temp customer to test with");
  }
  const noMatch = await resolveDefaultAgentForNumber(customerId, "+919999999999");
  check("returns null for an unrecognized number", noMatch === null, noMatch);
  const noAgentSet = await resolveDefaultAgentForNumber(customerId, testNumberA);
  check("returns null when the number has no default_agent_id set", noAgentSet === null, noAgentSet);

  section("setPrimaryPhoneNumber");
  const setOk = await setPrimaryPhoneNumber(customerId, createdB.id);
  check("setPrimaryPhoneNumber succeeds for an owned number", setOk === true);
  const afterSetPrimary = await getPhoneNumbersForCustomer(customerId);
  const aRow = afterSetPrimary.find((n) => n.id === created.id);
  const bRow = afterSetPrimary.find((n) => n.id === createdB.id);
  check("old primary (A) is no longer primary", aRow?.is_primary === false, aRow);
  check("new primary (B) is now primary", bRow?.is_primary === true, bRow);
  const setOkOtherCustomer = await setPrimaryPhoneNumber("00000000-0000-0000-0000-000000000000", createdB.id);
  check("setPrimaryPhoneNumber returns false for a number not owned by that customer", setOkOtherCustomer === false);

  section("updatePhoneNumber");
  const updated = await updatePhoneNumber(customerId, created.id, { label: "Renamed", isEnabled: false });
  check("label and is_enabled updated", updated?.label === "Renamed" && updated?.is_enabled === false, updated);

  section("deletePhoneNumber");
  const del1 = await deletePhoneNumber(customerId, created.id);
  const del2 = await deletePhoneNumber(customerId, createdB.id);
  check("both test numbers deleted", del1 === true && del2 === true);
  const delAgain = await deletePhoneNumber(customerId, created.id);
  check("deleting an already-deleted number returns false (idempotent, no error)", delAgain === false);

  const finalList = await getPhoneNumbersForCustomer(customerId);
  check(
    "no leftover test numbers after cleanup",
    !finalList.some((n) => n.phone_number === testNumberA || n.phone_number === testNumberB),
    finalList
  );

  await pool.end();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-company-phone-numbers crashed:", err);
  process.exit(1);
});
