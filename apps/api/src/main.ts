import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { verifyStartupDependencies } from "@agent-platform/core";
import { createLogger } from "@agent-platform/observability";
import { registerHealthRoutes } from "./routes/health.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerTelegramWebhook } from "./routes/telegram-webhook.js";

const logger = createLogger();
const app = Fastify({
  requestIdHeader: "x-request-id",
  loggerInstance: logger
});
const routeApp = app as unknown as FastifyInstance;

app.addHook("onRequest", async (request) => {
  const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
  request.log.info({ requestId }, "incoming request");
});

await registerHealthRoutes(routeApp);
await registerStatusRoutes(routeApp);
await registerTelegramWebhook(routeApp);

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? "0.0.0.0";

await verifyStartupDependencies("api", logger);

app.listen({ port, host }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
