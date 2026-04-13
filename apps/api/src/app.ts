import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { healthRoutes } from "./routes/health";
import { customerRoutes } from "./routes/customers";
import { kbRoutes } from "./routes/kb";
import { askRoutes } from "./routes/ask";
import { chatRoutes } from "./routes/chat";
import { agentRoutes } from "./routes/agents";
import { voiceRoutes } from "./routes/voice";
import { settingsRoutes } from "./routes/settings";
import { exotelVoicebotRoutes } from "./routes/exotel-voicebot";
import { exotelSettingsRoutes } from "./routes/exotel-settings";
import { registerSwagger } from "./plugins/swagger";

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, { origin: true }); // Allow all origins (required for Swagger UI Try it out)
  await app.register(websocket);               // Enable WebSocket support for Exotel Voicebot
  await registerSwagger(app);

  app.register(healthRoutes);
  app.register(customerRoutes);
  app.register(settingsRoutes);
  app.register(agentRoutes);
  app.register(kbRoutes);
  app.register(askRoutes);
  app.register(chatRoutes);
  app.register(voiceRoutes);
  app.register(exotelVoicebotRoutes);          // Exotel Voicebot WebSocket (multi-tenant)
  app.register(exotelSettingsRoutes);           // Exotel settings admin API

  return app;
}
