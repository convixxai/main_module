// ============================================================
// One customer's server log lines (for the SaaS and admins).
//
//   GET /logs/dates           days that have a server log file
//   GET /logs/daily?date=...  that customer's log lines for one India (IST)
//                             day, with counts per hour, level and message
//
// Server log files (logs/convixx-YYYY-MM-DD.log, JSON lines, one file per
// UTC day, times in IST) hold every customer. A line belongs to this
// customer when it carries the customer id, or the stream / call id of one
// of the customer's calls that day (call lines carry those, not the
// customer id). Secrets (API keys, tokens, auth headers) are masked.
// The whole file for every customer stays admin-only: GET /admin/logs.
//
// Auth: x-api-key, or x-admin-token with x-customer-id / customer_id.
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import readline from "readline";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyOrAdminAuth, AuthenticatedRequest } from "../middleware/auth";
import { getLogDirectory } from "../config/logger-factory";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOG_NAME_RE = /^convixx-(\d{4}-\d{2}-\d{2})\.log$/;
const LEVELS: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const LEVEL_NUM: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const SECRET_KEY_RE = /^(x-api-key|x-admin-token|authorization|cookie|set-cookie|api[_-]?key|token|access[_-]?token|password|secret|credentials?(_enc)?)$/i;
/** Lines kept in memory for one request, newest kept when exceeded. */
const MAX_MATCHED_LINES = 20_000;

const dailyQuery = z.object({
  date: z.string().regex(DATE_RE).optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  q: z.string().max(200).optional(),
  msg: z.string().max(200).optional(),
  hour: z.coerce.number().int().min(0).max(23).optional(),
  order: z.enum(["newest", "oldest"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mask secret values anywhere in a parsed log line. */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) && val != null && val !== "" ? "[hidden]" : redact(val, depth + 1);
  }
  return out;
}

async function logFileDates(): Promise<string[]> {
  try {
    const names = await fsp.readdir(getLogDirectory());
    return names.map((n) => n.match(LOG_NAME_RE)?.[1]).filter((d): d is string => !!d).sort().reverse();
  } catch {
    return [];
  }
}

/** Stream / call ids of this customer's calls that touch the IST day (calls log these, not the customer id). */
async function callIdsFor(customerId: string, date: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT exotel_stream_sid, exotel_call_sid, chat_session_id::text AS chat, id::text AS id FROM exotel_call_sessions
      WHERE customer_id = $1
        AND (started_at AT TIME ZONE 'UTC') < ((($2)::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND COALESCE(ended_at, started_at) AT TIME ZONE 'UTC' >= (($2)::date::timestamp AT TIME ZONE 'Asia/Kolkata') - interval '3 hours'
      LIMIT 5000`,
    [customerId, date]
  );
  const ids = new Set<string>();
  for (const row of r.rows) {
    for (const v of [row.exotel_stream_sid, row.exotel_call_sid, row.chat, row.id]) {
      // Short ids (e.g. a 6-digit number) would match unrelated lines.
      if (v && String(v).length >= 8) ids.add(String(v));
    }
  }
  return [...ids];
}

type Entry = { time: string; level: string; msg: string; line: Record<string, unknown> };

export async function customerLogRoutes(app: FastifyInstance) {
  app.get("/logs/dates", { preHandler: apiKeyOrAdminAuth }, async () => {
    const files = await logFileDates();
    // Each UTC file holds 05:30 IST that day to 05:30 IST the next: an IST day can be read when it or the day before has a file.
    const ist = new Set<string>();
    for (const d of files) {
      ist.add(d);
      ist.add(addDays(d, 1));
    }
    const today = istToday();
    return { timezone: "Asia/Kolkata", dates: [...ist].filter((d) => d <= today).sort().reverse() };
  });

  app.get("/logs/daily", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const q = dailyQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const f = q.data;
    const date = f.date ?? istToday();
    const customerId = request.customerId!;
    const dir = getLogDirectory();
    // IST day D = UTC files D-1 (from 18:30) and D (until 18:30).
    const files = [addDays(date, -1), date]
      .map((d) => path.resolve(dir, `convixx-${d}.log`))
      .filter((p) => p.startsWith(dir + path.sep) && fs.existsSync(p));
    if (files.length === 0) return reply.status(404).send({ error: `No server log for ${date}`, date });

    const needles = [customerId, ...(await callIdsFor(customerId, date))];
    const minLevel = f.level ? LEVEL_NUM[f.level] : 0;
    const text = f.q?.toLowerCase();
    const msgFilter = f.msg?.toLowerCase();

    const byHour = new Array(24).fill(0) as number[];
    const byLevel: Record<string, number> = {};
    const byMsg = new Map<string, number>();
    let matched: Entry[] = [];
    let total = 0;
    let truncated = false;

    for (const file of files) {
      const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (!raw.startsWith(`{"level":`) || !raw.includes(`"time":"${date}`)) continue;
        if (!needles.some((n) => raw.includes(n))) continue;
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        const time = String(line.time ?? "");
        if (!time.startsWith(date)) continue;
        const levelNum = Number(line.level) || 30;
        if (levelNum < minLevel) continue;
        const hour = Number(time.slice(11, 13));
        if (f.hour !== undefined && hour !== f.hour) continue;
        const msg = String(line.msg ?? "");
        if (msgFilter && !msg.toLowerCase().includes(msgFilter)) continue;
        if (text && !raw.toLowerCase().includes(text)) continue;
        const level = LEVELS[levelNum] ?? String(levelNum);
        total++;
        if (Number.isFinite(hour)) byHour[hour]++;
        byLevel[level] = (byLevel[level] ?? 0) + 1;
        byMsg.set(msg, (byMsg.get(msg) ?? 0) + 1);
        matched.push({ time, level, msg, line });
        if (matched.length > MAX_MATCHED_LINES) {
          matched = matched.slice(-Math.floor(MAX_MATCHED_LINES / 2));
          truncated = true;
        }
      }
    }

    const ordered = f.order === "newest" ? matched.reverse() : matched;
    const page = ordered.slice(f.offset, f.offset + f.limit).map((e) => {
      const { level: _l, time: _t, msg: _m, pid: _p, hostname: _h, ...rest } = redact(e.line) as Record<string, unknown>;
      return { time_ist: e.time, level: e.level, msg: e.msg, data: rest };
    });

    return {
      date,
      timezone: "Asia/Kolkata",
      filters: { level: f.level ?? null, q: f.q ?? null, msg: f.msg ?? null, hour: f.hour ?? null, order: f.order },
      total,
      limit: f.limit,
      offset: f.offset,
      truncated,
      summary: {
        by_hour_ist: byHour.map((n, h) => ({ hour: h, lines: n })).filter((x) => x.lines > 0),
        by_level: byLevel,
        top_messages: [...byMsg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([msg, n]) => ({ msg, lines: n })),
      },
      logs: page,
    };
  });
}
