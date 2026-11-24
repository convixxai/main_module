// One-off: fill exotel_call_sessions.agent_id on old rows from data that
// already records the agent (the call's chat session: chat_sessions.agent_id,
// set when the call's agent was chosen). Never guesses an agent.
//
// Dry run by default (prints what it would change). Writes only with --apply.
//   cd apps/api
//   npx ts-node --transpile-only scripts/backfill-call-session-agents.ts           # dry run
//   npx ts-node --transpile-only scripts/backfill-call-session-agents.ts --apply   # write
//
// Rows left NULL afterwards: calls with no chat session (the call ended
// before the bot started), or whose chat session never got an agent (the
// customer had no active agent then).

import { pool } from "../src/config/db";

const FILLABLE = `
  FROM exotel_call_sessions s
  JOIN chat_sessions c ON c.id = s.chat_session_id
  JOIN agents a ON a.id = c.agent_id AND a.customer_id = s.customer_id
 WHERE s.agent_id IS NULL`;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const before = await pool.query(
    `SELECT COUNT(*)::int AS missing,
            COUNT(*) FILTER (WHERE chat_session_id IS NULL)::int AS no_chat_session
       FROM exotel_call_sessions WHERE agent_id IS NULL`
  );
  const fillable = await pool.query(`SELECT s.customer_id, COUNT(*)::int AS rows ${FILLABLE} GROUP BY 1 ORDER BY 2 DESC`);
  const total = fillable.rows.reduce((n, r) => n + r.rows, 0);
  console.log(`Call sessions without an agent: ${before.rows[0].missing} (no chat session: ${before.rows[0].no_chat_session})`);
  console.log(`Can be filled from the call's chat session: ${total}`);
  for (const r of fillable.rows) console.log(`  customer ${r.customer_id}: ${r.rows}`);

  if (!apply) {
    console.log("Dry run: nothing written. Re-run with --apply to write.");
  } else if (total > 0) {
    const r = await pool.query(
      `UPDATE exotel_call_sessions s SET agent_id = c.agent_id
         FROM chat_sessions c, agents a
        WHERE c.id = s.chat_session_id AND a.id = c.agent_id AND a.customer_id = s.customer_id
          AND s.agent_id IS NULL`
    );
    console.log(`Updated ${r.rowCount} rows.`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
