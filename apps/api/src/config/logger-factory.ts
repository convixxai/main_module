import fs from "fs";
import path from "path";
import pino from "pino";
import { env } from "./env";
import { DailyLogFileStream } from "../services/daily-log-file-stream";

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
      const fileStream = new DailyLogFileStream(env.logFileDir);
      fileStream.on("error", (err) => {
        console.error("Daily log file stream error:", err);
      });
      streams.push({ level, stream: fileStream });
    } catch (e) {
      console.error("Could not enable file logging:", e);
    }
  }

  return pino({ level }, pino.multistream(streams));
}

/** Resolved absolute path to the log directory (for admin API). */
export function getLogDirectory(): string {
  return path.resolve(env.logFileDir);
}
