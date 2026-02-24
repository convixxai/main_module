import { FastifyInstance } from "fastify";
import path from "path";
import fs from "fs";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

export async function registerSwagger(app: FastifyInstance) {
  const specPath = path.join(process.cwd(), "spec", "openapi.json");
  const altPath = path.join(__dirname, "..", "..", "spec", "openapi.json");
  const resolvedPath = fs.existsSync(specPath) ? specPath : altPath;

  if (!fs.existsSync(resolvedPath)) {
    app.log.warn("Swagger spec not found, skipping /docs");
    return;
  }

  await app.register(swagger, {
    mode: "static",
    specification: {
      path: resolvedPath,
      baseDir: path.dirname(resolvedPath),
    },
  });

  const convixxLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 32" width="160" height="32">
    <text x="0" y="24" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="600" fill="#ffffff">Convixx AI</text>
  </svg>`;

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    logo: {
      type: "image/svg+xml",
      content: Buffer.from(convixxLogoSvg),
      href: "/",
      target: "_self" as const,
    },
    theme: { title: "Convixx API" },
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      tryItOutEnabled: true,
    },
    staticCSP: true,
  });

  app.log.info("Swagger UI available at /docs");
}
