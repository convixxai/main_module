import type { FastifyInstance } from "fastify";
import { recordApiRequest } from "../services/api-request-log";

/**
 * Access + error logging. Uses `disableRequestLogging` in `buildApp` so each
 * request produces explicit `http.in` / `http.out` lines instead of relying on defaults.
 *
 * Must be invoked as `registerRequestLogging(app)` on the **root** Fastify instance — do not
 * wrap in `app.register()`, or Fastify encapsulation will hide these hooks from sibling routes.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      },
      "http.in"
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        ip: request.ip,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime ?? 0),
      },
      "http.out"
    );
    // API key request log (C1): in-memory push only; written later in batches.
    const r = request as typeof request & { apiKeyId?: string; customerId?: string };
    if (r.apiKeyId && r.customerId) {
      recordApiRequest({
        customerId: r.customerId,
        apiKeyId: r.apiKeyId,
        method: request.method,
        path: request.url.split("?")[0].slice(0, 300),
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime ?? 0),
        at: new Date(),
      });
    }
  });

  app.addHook("onError", async (request, _reply, error) => {
    request.log.error(
      { err: error, reqId: request.id, method: request.method, url: request.url },
      "http.error"
    );
  });
}
