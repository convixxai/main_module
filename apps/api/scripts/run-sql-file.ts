// One-off helper: execute a .sql file against the DB configured in apps/api/.env
// (via src/config/db, which reads PG_HOST/PG_PORT/PG_USER/PG_PASS/PG_DB).
// Usage (from apps/api): npx ts-node scripts/run-sql-file.ts <path-to-sql-file>

import fs from "fs";
import path from "path";
import { pool } from "../src/config/db";

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: ts-node scripts/run-sql-file.ts <path-to-sql-file>");
    process.exit(1);
  }
  const sql = fs.readFileSync(path.resolve(filePath), "utf8");
  console.log(`Connecting to ${process.env.PG_HOST}/${process.env.PG_DB} as ${process.env.PG_USER} ...`);
  await pool.query(sql);
  console.log(`Applied: ${filePath}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Failed to apply SQL file:", err);
  process.exit(1);
});
