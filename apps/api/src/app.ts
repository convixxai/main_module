import Fastify from "fastify";
import { healthRoutes } from "./routes/health";
import { customerRoutes } from "./routes/customers";
import { kbRoutes } from "./routes/kb";
import { askRoutes } from "./routes/ask";
import { chatRoutes } from "./routes/chat";
import { agentRoutes } from "./routes/agents";

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.register(healthRoutes);
  app.register(customerRoutes);
  app.register(agentRoutes);
  app.register(kbRoutes);
  app.register(askRoutes);
  app.register(chatRoutes);

  return app;
}
