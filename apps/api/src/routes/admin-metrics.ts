// ============================================================
// Engine monitoring for the SaaS (admin token only, read only):
//   GET /admin/metrics?minutes=15     latency per route + per-turn call timings (C4)
//   GET /admin/events?since=&limit=   restarts, slow requests, server errors, errors, warnings (C5)
// Both are computed from the server log files on request (services/log-metrics.ts):
// nothing is added to requests or calls.
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminAuth } from "../middleware/auth";
import { engineEvents, engineMetrics, type EngineEventType } from "../services/log-metrics";

const metricsQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).default(15),
});

const EVENT_TYPES = ["restart", "slow_request", "server_error", "error", "warning"] as const;

const eventsQuery = z.object({
  /** ISO time; default: 24 hours ago. At most 7 days back (log retention). */
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** A request slower than this is a slow_request (default 3000 ms). */
  slow_ms: z.coerce.number().int().min(100).max(600_000).default(3000),
  /** Comma-separated subset of: restart, slow_request, server_error, error, warning. */
  types: z.string().max(100).optional(),
});

export async function adminMetricsRoutes(app: FastifyInstance) {
  app.get("/admin/metrics", { preHandler: adminAuth }, async (request, reply) => {
    const q = metricsQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    return engineMetrics(q.data.minutes);
  });

  app.get("/admin/events", { preHandler: adminAuth }, async (request, reply) => {
    const q = eventsQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const weekAgo = Date.now() - 7 * 86_400_000;
    const since = new Date(Math.max(weekAgo, q.data.since ? Date.parse(q.data.since) : Date.now() - 86_400_000));
    let types: EngineEventType[] | undefined;
    if (q.data.types) {
      const list = q.data.types.split(",").map((t) => t.trim()).filter(Boolean);
      const bad = list.filter((t) => !(EVENT_TYPES as readonly string[]).includes(t));
      if (bad.length) return reply.status(400).send({ error: `Unknown type(s): ${bad.join(", ")}. Use: ${EVENT_TYPES.join(", ")}` });
      types = list as EngineEventType[];
    }
    // Rounded to the minute so repeated polls share the 15 s cache.
    const sinceRounded = new Date(Math.floor(since.getTime() / 60_000) * 60_000);
    return engineEvents({ since: sinceRounded, limit: q.data.limit, slowMs: q.data.slow_ms, types });
  });
}
