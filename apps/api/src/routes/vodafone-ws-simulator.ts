// ============================================================
// Route for the standalone Vodafone (VI) WebSocket Simulator page.
//
// Serves ONE static, unauthenticated HTML page. All simulation logic runs
// client-side in the browser (see vodafone-ws-simulator-page.ts's header) -
// this route does nothing but return that HTML. It has no dependency on,
// and makes no changes to, vodafone-voicebot.ts / vodafone-adapter.ts / any
// other live route.
// ============================================================

import { FastifyInstance } from "fastify";
import { VODAFONE_WS_SIMULATOR_PAGE_HTML } from "./vodafone-ws-simulator-page";

export async function vodafoneWsSimulatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/qa/vodafone-ws-simulator", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(VODAFONE_WS_SIMULATOR_PAGE_HTML);
  });
}
