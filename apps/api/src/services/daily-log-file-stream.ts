import fs from "fs";
import path from "path";
import { Writable } from "stream";

/**
 * Append-only writable stream that switches to a new file at UTC midnight.
 * Filenames: `{prefix}-YYYY-MM-DD.log` under `logDir`.
 */
export class DailyLogFileStream extends Writable {
  private readonly logDir: string;
  private readonly prefix: string;
  private readonly retentionDays: number;
  private currentDate: string | null = null;
  private fileStream: fs.WriteStream | null = null;

  constructor(logDir: string, prefix = "convixx", retentionDays = 7) {
    super();
    this.logDir = logDir;
    this.prefix = prefix;
    this.retentionDays = retentionDays;
  }

  private dateKey(d = new Date()): string {
    return d.toISOString().slice(0, 10);
  }

  private filePathForDate(date: string): string {
    return path.join(this.logDir, `${this.prefix}-${date}.log`);
  }

  /**
   * Deletes rotated log files older than `retentionDays`. Runs once per
   * calendar-day rotation (see openStreamForDate) rather than on a separate
   * timer — no extra scheduling infrastructure needed, and it self-corrects
   * even if the process was down for a few days. Best-effort: failures are
   * swallowed so a log-cleanup issue never takes down logging itself.
   */
  private purgeOldLogs(): void {
    const re = new RegExp(`^${this.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    fs.readdir(this.logDir, (err, entries) => {
      if (err) return;
      for (const name of entries) {
        const m = name.match(re);
        if (!m) continue;
        const fileDateMs = Date.parse(`${m[1]}T00:00:00Z`);
        if (Number.isNaN(fileDateMs) || fileDateMs >= cutoff) continue;
        fs.unlink(path.join(this.logDir, name), () => {
          /* best-effort */
        });
      }
    });
  }

  private openStreamForDate(date: string): void {
    if (this.fileStream && !this.fileStream.destroyed) {
      this.fileStream.end();
    }
    this.currentDate = date;
    this.fileStream = fs.createWriteStream(this.filePathForDate(date), {
      flags: "a",
    });
    this.fileStream.on("error", (err) => this.emit("error", err));
    this.purgeOldLogs();
  }

  private ensureOpen(): void {
    const date = this.dateKey();
    if (this.currentDate === date && this.fileStream && !this.fileStream.destroyed) {
      return;
    }
    this.openStreamForDate(date);
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    try {
      this.ensureOpen();
      const ws = this.fileStream!;
      if (ws.write(chunk)) {
        process.nextTick(callback);
      } else {
        ws.once("drain", callback);
      }
    } catch (e) {
      process.nextTick(() => callback(e as Error));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.fileStream && !this.fileStream.destroyed) {
      this.fileStream.end(callback);
    } else {
      callback();
    }
  }
}
