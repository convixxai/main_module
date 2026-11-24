// ============================================================
// Post-call analysis worker: a separate process from the API (see
// jobs/call-insights.ts). Start on the server, after `npm run build`:
//
//   pm2 start dist/jobs/call-insights-worker.js --name convixx-call-insights
//   pm2 save
//
// Every CALL_INSIGHTS_INTERVAL_SECONDS (default 60) it analyses up to
// CALL_INSIGHTS_BATCH (default 10) ended calls from the last
// CALL_INSIGHTS_LOOKBACK_DAYS (default 3) days. CALL_INSIGHTS_MODEL forces
// one model for every customer (default: the customer's own model setting).
// `node dist/jobs/call-insights-worker.js --once` runs one pass and exits.
// Stopping it (pm2 stop convixx-call-insights) stops the analysis; calls are
// not affected either way.
// ============================================================

import { pool } from "../config/db";
import { tableExists } from "../services/schema-features";
import { runInsightsBatch } from "./call-insights";

const num = (v: string | undefined, def: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : def;
};

const intervalMs = num(process.env.CALL_INSIGHTS_INTERVAL_SECONDS, 60, 10, 3600) * 1000;
const options = {
  batch: num(process.env.CALL_INSIGHTS_BATCH, 10, 1, 200),
  lookbackDays: num(process.env.CALL_INSIGHTS_LOOKBACK_DAYS, 3, 1, 366),
  model: process.env.CALL_INSIGHTS_MODEL?.trim() || null,
  log: (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra })),
};

let stopping = false;

async function pass(): Promise<void> {
  if (!(await tableExists("call_insights"))) {
    options.log("call-insights: waiting for migration 028 (table call_insights missing)");
    return;
  }
  const r = await runInsightsBatch(options);
  if (r.done || r.failed) options.log("call-insights: pass", r);
}

async function main(): Promise<void> {
  options.log("call-insights: worker started", { interval_ms: intervalMs, batch: options.batch, lookback_days: options.lookbackDays, model: options.model ?? "customer setting" });
  if (process.argv.includes("--once")) {
    await pass();
    await pool.end();
    return;
  }
  while (!stopping) {
    try {
      await pass();
    } catch (err) {
      options.log("call-insights: pass failed", { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await pool.end();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
