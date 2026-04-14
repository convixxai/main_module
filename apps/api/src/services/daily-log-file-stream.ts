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
  private currentDate: string | null = null;
  private fileStream: fs.WriteStream | null = null;

  constructor(logDir: string, prefix = "convixx") {
    super();
    this.logDir = logDir;
    this.prefix = prefix;
  }

  private dateKey(d = new Date()): string {
    return d.toISOString().slice(0, 10);
  }

  private filePathForDate(date: string): string {
    return path.join(this.logDir, `${this.prefix}-${date}.log`);
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
