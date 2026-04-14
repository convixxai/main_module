import { env } from "./config/env";
import { buildApp } from "./app";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    app.log.info(`Server listening on http://0.0.0.0:${env.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
