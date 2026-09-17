import fs from "fs";
import path from "path";
import pino from "pino";
import { env } from "./env";
import { DailyLogFileStream } from "../services/daily-log-file-stream";

// `hour12: false` alone does NOT guarantee a 0-23 range - ICU's en-CA locale
// resolves that to the h24 cycle, where midnight prints as "24:00:00" on the
// FOLLOWING calendar date instead of "00:00:00" (confirmed: formatting
// 2026-09-17T18:30:00Z, which is 2026-09-18 00:00:00 IST, produces
// "2026-09-18, 24:00:00"). Every log line in the 00:00-00:59 IST hour has
// been silently mis-timestamped this way since this formatter was written -
// explaining the "24:xx:xx" timestamps seen throughout today's logs, which
// made chronological log analysis during that hour unreliable. `hourCycle:
// 'h23'` forces the 0-23 range explicitly instead of leaving it to the
// locale's default.
const tzFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  hourCycle: 'h23',
});

function getKolkataTime() {
  return tzFormatter.format(new Date()).replace(", ", " ");
}

/**
 * Root Pino logger: stdout + optional daily rotating file under `env.logFileDir`.
 * File logging works whenever the process runs (PM2, systemd, etc.) — independent of SSH.
 */
export function createRootLogger(): pino.Logger {
  const level = env.logLevel as pino.Level;

  const streams: pino.StreamEntry[] = [
    { level, stream: process.stdout },
  ];

  if (env.logFileEnabled) {
    try {
      fs.mkdirSync(env.logFileDir, { recursive: true });
      const fileStream = new DailyLogFileStream(env.logFileDir, "convixx", env.logRetentionDays);
      fileStream.on("error", (err) => {
        console.error("Daily log file stream error:", err);
      });
      streams.push({ level, stream: fileStream });
    } catch (e) {
      console.error("Could not enable file logging:", e);
    }
  }

  return pino({ 
    level,
    timestamp: () => `,"time":"${getKolkataTime()}"`
  }, pino.multistream(streams));
}

/** Resolved absolute path to the log directory (for admin API). */
export function getLogDirectory(): string {
  return path.resolve(env.logFileDir);
}
