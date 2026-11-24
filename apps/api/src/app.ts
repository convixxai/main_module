import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import { healthRoutes } from "./routes/health";
import { customerRoutes } from "./routes/customers";
import { kbRoutes } from "./routes/kb";
import { kbSuggestionRoutes } from "./routes/kb-suggestions";
import { setSuggestedKbLogger } from "./services/suggested-kb";
import { askRoutes } from "./routes/ask";
import { chatRoutes } from "./routes/chat";
import { agentRoutes } from "./routes/agents";
import { avatarRoutes } from "./routes/avatars";
import { voiceCatalogRoutes } from "./routes/voice-catalog";
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
import { callingRoutes } from "./routes/calling";
import { customerLogRoutes } from "./routes/customer-logs";
import { usageRoutes } from "./routes/usage";
import { adminMetricsRoutes } from "./routes/admin-metrics";
import { callInsightRoutes } from "./routes/call-insights";
import { outboundCampaignRoutes } from "./routes/outbound-campaigns";
import { vodafoneCampaignRoutes } from "./routes/vodafone-campaigns";
import { vodafoneReportRoutes, vodafoneOwnReportRoutes } from "./routes/vodafone-reports";
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
import { kbAdminGaneshotsavRoutes } from "./routes/kb-admin-ganeshotsav";
import { vodafoneWsSimulatorRoutes } from "./routes/vodafone-ws-simulator";
import { toolCallingSettingsRoutes } from "./routes/tool-calling-settings";
import { qaMockCrmRoutes } from "./routes/qa-mock-crm";
import { createRootLogger } from "./config/logger-factory";
import { startApiRequestLog } from "./services/api-request-log";
import { attachPoolQueryLogging } from "./config/db";
import { registerRequestLogging } from "./plugins/request-logging";
import { registerSwagger } from "./plugins/swagger";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: createRootLogger(),
    disableRequestLogging: true,
  }) as unknown as FastifyInstance;

  attachPoolQueryLogging(app.log);
  setSuggestedKbLogger(app.log);

  registerRequestLogging(app);
  startApiRequestLog(app.log);
  
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
  app.register(voiceCatalogRoutes);             // Unified cross-provider voice picker (GET /voices, /voices/sample)
  app.register(kbRoutes);
  app.register(kbSuggestionRoutes);             // Suggested KB review (pending / added / rejected)
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
  app.register(callingRoutes);                  // Calling switch on/off (0 credits) + calling logs + activity per hour/day/week/month
  app.register(customerLogRoutes);              // One customer's server log lines per IST day, with frequency summary
  app.register(usageRoutes);                    // API key request log + usage counters per customer (SaaS C1/C2)
  app.register(adminMetricsRoutes);             // Engine timings + events from the server logs (admin, SaaS C4/C5)
  app.register(callInsightRoutes);              // Post-call analysis settings + results (worker: jobs/call-insights-worker.ts)
  app.register(outboundCampaignRoutes);         // Outbound Campaign management & triggering
  app.register(vodafoneCampaignRoutes);         // Vodafone OBD campaigns (VI dials; never Exotel)
  app.register(vodafoneReportRoutes);           // Vodafone reports: campaign status/report/summary, call history (VI, read-only)
  app.register(vodafoneOwnReportRoutes);        // Vodafone reports from Convixx's own call log (read-only)
  app.register(kbAdminGaneshotsavRoutes);       // Temporary username/password-protected KB admin page (Ganeshotsav project)
  app.register(vodafoneWsSimulatorRoutes);      // Standalone VI WebSocket simulator page - does not touch the live Vodafone route
  app.register(toolCallingSettingsRoutes);    // GET/PUT/DELETE tool-calling prompt (mid-call CRM tools)
  app.register(qaMockCrmRoutes);              // QA-only mock customer CRM API for the tool-calling demo

  return app;
}
