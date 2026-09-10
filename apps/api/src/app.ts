import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import { healthRoutes } from "./routes/health";
import { customerRoutes } from "./routes/customers";
import { kbRoutes } from "./routes/kb";
import { askRoutes } from "./routes/ask";
import { chatRoutes } from "./routes/chat";
import { agentRoutes } from "./routes/agents";
import { avatarRoutes } from "./routes/avatars";
import { voiceRoutes } from "./routes/voice";
import { elevenlabsApiRoutes } from "./routes/elevenlabs-api";
import { settingsRoutes } from "./routes/settings";
import { exotelVoicebotRoutes } from "./routes/exotel-voicebot";
import { vodafoneVoicebotRoutes } from "./routes/vodafone-voicebot";
import { vodafoneSettingsRoutes } from "./routes/vodafone-settings";
import { exotelSettingsRoutes } from "./routes/exotel-settings";
import { companyPhoneNumbersRoutes } from "./routes/company-phone-numbers";
import { exotelOutboundCallRoutes } from "./routes/exotel-outbound-call";
import { exotelStatusCallbackRoutes } from "./routes/exotel-status-callback";
import { adminLogsRoutes } from "./routes/adminLogs";
import { outboundCampaignRoutes } from "./routes/outbound-campaigns";
import { voiceSimulatorRoutes } from "./routes/voice-simulator";
import { elevenlabsVoiceBrowserRoutes } from "./routes/elevenlabs-voice-browser";
import { openaiTtsSimulatorRoutes } from "./routes/openai-tts-simulator";
import { cartesiaSimulatorRoutes } from "./routes/cartesia-simulator";
import { cartesiaVoiceBrowserRoutes } from "./routes/cartesia-voice-browser";
import { cartesiaApiRoutes } from "./routes/cartesia-api";
import { simulatorSaveRoutes } from "./routes/simulator-save";
import { googleTtsSimulatorRoutes } from "./routes/google-tts-simulator";
import { sarvamTtsSimulatorRoutes } from "./routes/sarvam-tts-simulator";
import { voiceCartesiaTestConsoleRoutes } from "./routes/voice-cartesia-test-console";
import { qaTestConsoleRoutes } from "./routes/qa-test-console";
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
  
  // Debug hook to trace all Exotel Voicebot connection attempts
  app.addHook("preHandler", async (request) => {
    if (request.url.startsWith("/exotel/voicebot/")) {
      request.log.info({ url: request.url, method: request.method, headers: request.headers }, "Exotel Voicebot route hit");
    }
  });

  await app.register(cors, { origin: true }); // Allow all origins (required for Swagger UI Try it out)
  await app.register(websocket);               // Enable WebSocket support for Exotel Voicebot
  await app.register(formbody);                // Parse application/x-www-form-urlencoded (Exotel StatusCallbacks)
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
  app.register(voiceSimulatorRoutes);
  app.register(openaiTtsSimulatorRoutes);
  app.register(cartesiaSimulatorRoutes);
  app.register(cartesiaVoiceBrowserRoutes);
  app.register(cartesiaApiRoutes);
  app.register(voiceCartesiaTestConsoleRoutes); // TEMP: Cartesia voice test console, see docs note
  app.register(qaTestConsoleRoutes);            // QA test console: chat/audio pipeline test page with per-stage timings
  app.register(simulatorSaveRoutes);
  app.register(googleTtsSimulatorRoutes);
  app.register(sarvamTtsSimulatorRoutes);
  app.register(elevenlabsVoiceBrowserRoutes);
  app.register(elevenlabsApiRoutes);
  app.register(exotelVoicebotRoutes);          // Exotel Voicebot WebSocket (multi-tenant)
  app.register(vodafoneVoicebotRoutes);         // Vodafone (VI) Voicebot WebSocket (Feature 5)
  app.register(vodafoneSettingsRoutes);         // Vodafone settings admin API
  app.register(exotelSettingsRoutes);           // Exotel settings admin API
  app.register(companyPhoneNumbersRoutes);      // company_phone_numbers admin CRUD (Feature 3)
  app.register(exotelOutboundCallRoutes);       // Exotel outbound dial (REST Connect API)
  app.register(exotelStatusCallbackRoutes);      // Exotel HTTP StatusCallback (answered)
  app.register(adminLogsRoutes);                // Daily log file list + download (admin)
  app.register(outboundCampaignRoutes);         // Outbound Campaign management & triggering

  return app;
}
