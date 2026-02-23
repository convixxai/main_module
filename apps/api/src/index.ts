import { env } from "./config/env";
import { buildApp } from "./app";

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    console.log(`Server running on http://localhost:${env.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
