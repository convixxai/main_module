import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./routes/health";
import { customerRoutes } from "./routes/customers";
import { kbRoutes } from "./routes/kb";
import { askRoutes } from "./routes/ask";
import { chatRoutes } from "./routes/chat";
import { agentRoutes } from "./routes/agents";
import { avatarRoutes } from "./routes/avatars";
import { voiceRoutes } from "./routes/voice";
import { settingsRoutes } from "./routes/settings";
import { exotelVoicebotRoutes } from "./routes/exotel-voicebot";
import { exotelSettingsRoutes } from "./routes/exotel-settings";
import { adminLogsRoutes } from "./routes/adminLogs";
import { createRootLogger } from "./config/logger-factory";
import { attachPoolQueryLogging } from "./config/db";
import { registerRequestLogging } from "./plugins/request-logging";
import { registerSwagger } from "./plugins/swagger";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: createRootLogger(),
    disableRequestLogging: true,
  }) as unknown as FastifyInstance;

  attachPoolQueryLogging(app.log);

  registerRequestLogging(app);
  await app.register(cors, { origin: true }); // Allow all origins (required for Swagger UI Try it out)
  await app.register(websocket);               // Enable WebSocket support for Exotel Voicebot
  await registerSwagger(app);

  app.register(healthRoutes);
  app.register(customerRoutes);
  app.register(settingsRoutes);
  app.register(agentRoutes);
  app.register(avatarRoutes);
  app.register(kbRoutes);
  app.register(askRoutes);
  app.register(chatRoutes);
  app.register(voiceRoutes);
  app.register(exotelVoicebotRoutes);          // Exotel Voicebot WebSocket (multi-tenant)
  app.register(exotelSettingsRoutes);           // Exotel settings admin API
  app.register(adminLogsRoutes);                // Daily log file list + download (admin)

  return app;
}
