// ============================================================
// Temporary, single-customer KB admin web page for the Ganeshotsav project
// (customer_id 97752ef1-eb4f-4ebb-a77f-0613fe3a424b). Username/password
// protected, single active session per login (a new login anywhere
// overwrites kb_admin_users.session_token, which immediately invalidates
// whatever browser/window was using the previous one — enforced by
// validateKbAdminSession comparing against the CURRENT token on every call,
// and the page polling /api/session every 8s to notice and log itself out).
//
// Deliberately NOT the general customer-facing KB editor: this is scoped to
// one hardcoded customer_id, has no multi-tenant routing, and is meant to be
// retired once a real admin portal exists (see chat context 2026-09-15).
// ============================================================

import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import ExcelJS from "exceljs";
import { pool } from "../config/db";
import { generateEmbedding } from "../services/llm";
import {
  verifyKbAdminLogin,
  createKbAdminSession,
  clearKbAdminSession,
  validateKbAdminSession,
  type KbAdminUser,
} from "../services/kb-admin-auth";
import { KB_ADMIN_GANESHOTSAV_HTML } from "./kb-admin-ganeshotsav-page";

const CUSTOMER_ID = "97752ef1-eb4f-4ebb-a77f-0613fe3a424b";
const COOKIE_NAME = "kb_admin_ganeshotsav_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12; // 12h — a stale forgotten-open tab shouldn't stay valid forever

const REQUIRED_COLUMNS = ["questions", "answers"] as const;

// ---------- tiny in-memory login rate limiter (single-process PM2 fork; resets on restart) ----------
const loginAttempts = new Map<string, { count: number; firstAttemptAt: number }>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

function isRateLimited(key: string): boolean {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordFailedLogin(key: string): void {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearFailedLogins(key: string): void {
  loginAttempts.delete(key);
}

// ---------- cookie helpers (no @fastify/cookie dependency — one cookie, simple needs) ----------
function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(reply: any, token: string): void {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/kb-admin/ganeshotsav",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ];
  reply.header("set-cookie", attrs.join("; "));
}

function clearSessionCookie(reply: any): void {
  const attrs = [
    `${COOKIE_NAME}=`,
    "Path=/kb-admin/ganeshotsav",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ];
  reply.header("set-cookie", attrs.join("; "));
}

async function requireSession(request: any, reply: any): Promise<KbAdminUser | null> {
  const token = readCookie(request.headers.cookie, COOKIE_NAME);
  const user = await validateKbAdminSession(CUSTOMER_ID, token);
  if (!user) {
    reply.status(401).send({ error: "Not signed in, or signed in from another window/browser." });
    return null;
  }
  return user;
}

function normalizeHeaderName(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

export async function kbAdminGaneshotsavRoutes(app: FastifyInstance): Promise<void> {
  // ---------- page shell ----------
  app.get("/kb-admin/ganeshotsav", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(KB_ADMIN_GANESHOTSAV_HTML);
  });

  // ---------- auth ----------
  app.post<{ Body: { username?: string; password?: string } }>(
    "/kb-admin/ganeshotsav/api/login",
    async (request, reply) => {
      const ip = request.ip || "unknown";
      if (isRateLimited(ip)) {
        return reply.status(429).send({ error: "Too many failed attempts. Try again later." });
      }
      const { username, password } = request.body || {};
      if (!username || !password) {
        return reply.status(400).send({ error: "Username and password are required" });
      }
      const user = await verifyKbAdminLogin(CUSTOMER_ID, username, password);
      if (!user) {
        recordFailedLogin(ip);
        return reply.status(401).send({ error: "Invalid username or password" });
      }
      clearFailedLogins(ip);
      const token = await createKbAdminSession(user.id);
      setSessionCookie(reply, token);
      return reply.send({ username: user.username });
    }
  );

  app.post("/kb-admin/ganeshotsav/api/logout", async (request, reply) => {
    const token = readCookie(request.headers.cookie, COOKIE_NAME);
    const user = await validateKbAdminSession(CUSTOMER_ID, token);
    if (user) await clearKbAdminSession(user.id);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get("/kb-admin/ganeshotsav/api/session", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;
    return reply.send({ username: user.username });
  });

  // ---------- entries: list / add / edit ----------
  app.get("/kb-admin/ganeshotsav/api/entries", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;
    const r = await pool.query(
      `SELECT id, question, answer, created_at
       FROM kb_entries WHERE customer_id = $1 ORDER BY created_at DESC`,
      [CUSTOMER_ID]
    );
    return reply.send({ entries: r.rows });
  });

  app.post<{ Body: { question?: string; answer?: string } }>(
    "/kb-admin/ganeshotsav/api/entries",
    async (request, reply) => {
      const user = await requireSession(request, reply);
      if (!user) return;
      const question = (request.body?.question || "").trim();
      const answer = (request.body?.answer || "").trim();
      if (!question || !answer) {
        return reply.status(400).send({ error: "Question and answer are both required" });
      }
      const embedding = await generateEmbedding(question);
      const embeddingStr = `[${embedding.join(",")}]`;
      const r = await pool.query(
        `INSERT INTO kb_entries (customer_id, question, answer, embedding)
         VALUES ($1, $2, $3, $4) RETURNING id, question, answer, created_at`,
        [CUSTOMER_ID, question, answer, embeddingStr]
      );
      return reply.status(201).send(r.rows[0]);
    }
  );

  app.put<{ Params: { id: string }; Body: { question?: string; answer?: string } }>(
    "/kb-admin/ganeshotsav/api/entries/:id",
    async (request, reply) => {
      const user = await requireSession(request, reply);
      if (!user) return;
      const { id } = request.params;
      const question = (request.body?.question || "").trim();
      const answer = (request.body?.answer || "").trim();
      if (!question || !answer) {
        return reply.status(400).send({ error: "Question and answer are both required" });
      }
      const existing = await pool.query(
        `SELECT id FROM kb_entries WHERE id = $1 AND customer_id = $2`,
        [id, CUSTOMER_ID]
      );
      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: "Entry not found" });
      }
      const embedding = await generateEmbedding(question);
      const embeddingStr = `[${embedding.join(",")}]`;
      const r = await pool.query(
        `UPDATE kb_entries SET question = $1, answer = $2, embedding = $3
         WHERE id = $4 AND customer_id = $5 RETURNING id, question, answer, created_at`,
        [question, answer, embeddingStr, id, CUSTOMER_ID]
      );
      return reply.send(r.rows[0]);
    }
  );

  // ---------- bulk delete (also used for single-row delete by the UI) ----------
  app.post<{ Body: { ids?: string[] } }>(
    "/kb-admin/ganeshotsav/api/entries/bulk-delete",
    async (request, reply) => {
      const user = await requireSession(request, reply);
      if (!user) return;
      const ids = Array.isArray(request.body?.ids) ? request.body!.ids!.filter((x) => typeof x === "string") : [];
      if (ids.length === 0) {
        return reply.status(400).send({ error: "No entry ids provided" });
      }
      const r = await pool.query(
        `DELETE FROM kb_entries WHERE customer_id = $1 AND id = ANY($2::uuid[]) RETURNING id`,
        [CUSTOMER_ID, ids]
      );
      return reply.send({ deleted: r.rowCount });
    }
  );

  // ---------- bulk upload from .xlsx ----------
  // Registered on its own encapsulated sub-scope (mirrors ask.ts/voice.ts/
  // qa-test-console.ts) - @fastify/multipart's content-type parser can only
  // be added once per Fastify instance tree, and several other route files
  // already register it scoped to themselves; registering it on the shared
  // root `app` in app.ts collided with those and crashed the process on boot.
  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 10 * 1024 * 1024 },
    });

    scoped.post("/kb-admin/ganeshotsav/api/entries/bulk-upload", async (request: any, reply) => {
      const user = await requireSession(request, reply);
      if (!user) return;

      if (!request.isMultipart?.()) {
        return reply.status(400).send({ error: "Expected a multipart/form-data upload with a 'file' field" });
      }
      const filePart = await request.file();
      if (!filePart) {
        return reply.status(400).send({ error: "No file uploaded" });
      }
      const buffer = await filePart.toBuffer();

      const workbook = new ExcelJS.Workbook();
      try {
        await workbook.xlsx.load(buffer);
      } catch {
        return reply.status(400).send({ error: "Could not read this file — is it a valid .xlsx file?" });
      }
      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        return reply.status(400).send({ error: "The file has no sheets" });
      }

      const headerRow = worksheet.getRow(1);
      const headerCells: string[] = [];
      headerRow.eachCell({ includeEmpty: false }, (cell) => {
        headerCells.push(normalizeHeaderName(cell.value));
      });

      const isExactMatch =
        headerCells.length === REQUIRED_COLUMNS.length &&
        REQUIRED_COLUMNS.every((col) => headerCells.includes(col));

      if (!isExactMatch) {
        return reply.status(400).send({
          error:
            `Invalid file format. Expected exactly two columns named "Questions" and "Answers" ` +
            `(first row = header). Found: ${headerCells.length ? headerCells.join(", ") : "(no header row)"}.`,
        });
      }

      const questionColIdx = headerCells.indexOf("questions") + 1;
      const answerColIdx = headerCells.indexOf("answers") + 1;

      const rowsToInsert: { question: string; answer: string }[] = [];
      let skippedBlank = 0;
      for (let r = 2; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const question = String(row.getCell(questionColIdx).value ?? "").trim();
        const answer = String(row.getCell(answerColIdx).value ?? "").trim();
        if (!question && !answer) {
          skippedBlank++;
          continue;
        }
        if (!question || !answer) {
          return reply.status(400).send({
            error: `Row ${r}: both Question and Answer must be filled in (found only one of the two).`,
          });
        }
        rowsToInsert.push({ question, answer });
      }

      if (rowsToInsert.length === 0) {
        return reply.status(400).send({ error: "No usable rows found in the file" });
      }

      const embeddings = await Promise.all(rowsToInsert.map((row) => generateEmbedding(row.question)));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let i = 0; i < rowsToInsert.length; i++) {
          const embeddingStr = `[${embeddings[i].join(",")}]`;
          await client.query(
            `INSERT INTO kb_entries (customer_id, question, answer, embedding) VALUES ($1, $2, $3, $4)`,
            [CUSTOMER_ID, rowsToInsert[i].question, rowsToInsert[i].answer, embeddingStr]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return reply.status(201).send({ inserted: rowsToInsert.length, skipped: skippedBlank });
    });
  });

  // ---------- downloadable template matching the required format exactly ----------
  app.get("/kb-admin/ganeshotsav/api/template.xlsx", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.columns = [
      { header: "Questions", key: "question", width: 60 },
      { header: "Answers", key: "answer", width: 80 },
    ];
    sheet.addRow({
      question: "What are the check-in and check-out timings?",
      answer: "Check-in is 2:00 PM and check-out is 11:00 AM.",
    });
    const buffer = await workbook.xlsx.writeBuffer();
    reply
      .header("Content-Disposition", 'attachment; filename="ganeshotsav_kb_template.xlsx"')
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(Buffer.from(buffer));
  });
}
