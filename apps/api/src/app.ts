import Fastify from "fastify";
import { healthRoutes } from "./routes/health";
import { customerRoutes } from "./routes/customers";
import { kbRoutes } from "./routes/kb";
import { askRoutes } from "./routes/ask";
import { chatRoutes } from "./routes/chat";
import { agentRoutes } from "./routes/agents";
import { registerSwagger } from "./plugins/swagger";

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await registerSwagger(app);

  app.register(healthRoutes);
  app.register(customerRoutes);
  app.register(agentRoutes);
  app.register(kbRoutes);
  app.register(askRoutes);
  app.register(chatRoutes);

  return app;
}
