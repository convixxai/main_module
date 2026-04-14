import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";
import type { FastifyInstance } from "fastify";
import { adminAuth } from "../middleware/auth";
import { env } from "../config/env";
import { getLogDirectory } from "../config/logger-factory";

const LOG_NAME_RE = /^convixx-(\d{4}-\d{2}-\d{2})\.log$/;

function parseLogDate(filename: string): string | null {
  const m = filename.match(LOG_NAME_RE);
  return m ? m[1]! : null;
}

function safeLogPathForDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const filename = `convixx-${date}.log`;
  const logDir = getLogDirectory();
  const resolved = path.resolve(logDir, filename);
  if (!resolved.startsWith(logDir + path.sep) && resolved !== logDir) {
    return null;
  }
  return resolved;
}

export async function adminLogsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/admin/logs",
    { preHandler: adminAuth },
    async (_request, reply) => {
      const logDir = getLogDirectory();
      let entries: string[] = [];
      try {
        entries = await fs.readdir(logDir);
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return reply.send({
            log_directory: logDir,
            file_log_enabled: env.logFileEnabled,
            total_files: 0,
            files: [] as Array<{
              date: string;
              filename: string;
              size_bytes: number;
              download_path: string;
            }>,
          });
        }
        throw e;
      }

      const files: Array<{
        date: string;
        filename: string;
        size_bytes: number;
        download_path: string;
      }> = [];

      for (const name of entries) {
        const date = parseLogDate(name);
        if (!date) continue;
        const full = path.join(logDir, name);
        try {
          const st = await fs.stat(full);
          if (!st.isFile()) continue;
          files.push({
            date,
            filename: name,
            size_bytes: st.size,
            download_path: `/admin/logs/${date}`,
          });
        } catch {
          continue;
        }
      }

      files.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      return reply.send({
        log_directory: logDir,
        file_log_enabled: env.logFileEnabled,
        total_files: files.length,
        files,
      });
    }
  );

  app.get<{ Params: { date: string } }>(
    "/admin/logs/:date",
    { preHandler: adminAuth },
    async (request, reply) => {
      const resolved = safeLogPathForDate(request.params.date);
      if (!resolved) {
        return reply.status(400).send({ error: "Invalid date; use YYYY-MM-DD" });
      }

      try {
        await fs.access(resolved);
      } catch {
        return reply.status(404).send({ error: "Log file not found for this date" });
      }

      const filename = path.basename(resolved);
      reply.header(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      reply.type("application/x-ndjson; charset=utf-8");
      return reply.send(createReadStream(resolved));
    }
  );
}
