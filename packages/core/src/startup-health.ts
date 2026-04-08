import { prisma } from "./db/client.js";
import { redisConnection } from "./db/redis.js";

interface LoggerLike {
  info(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
  error(payload: unknown, message?: string): void;
}

export async function verifyStartupDependencies(
  service: string,
  logger: LoggerLike,
  options: { attempts?: number; retryDelayMs?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 5_000;

  await checkWithRetry({
    name: "postgres",
    service,
    attempts,
    retryDelayMs,
    logger,
    check: async () => {
      await prisma.$queryRawUnsafe("SELECT 1");
    }
  });

  await checkWithRetry({
    name: "redis",
    service,
    attempts,
    retryDelayMs,
    logger,
    check: async () => {
      await redisConnection.ping();
    }
  });
}

async function checkWithRetry(input: {
  name: "postgres" | "redis";
  service: string;
  attempts: number;
  retryDelayMs: number;
  logger: LoggerLike;
  check: () => Promise<void>;
}) {
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      await input.check();
      input.logger.info(
        { service: input.service, dependency: input.name, attempt, ok: true },
        "Startup dependency check passed"
      );
      return;
    } catch (error) {
      const isLastAttempt = attempt === input.attempts;
      const payload = { service: input.service, dependency: input.name, attempt, err: error };

      if (isLastAttempt) {
        input.logger.error(payload, "Startup dependency check failed");
        throw error;
      }

      input.logger.warn(payload, "Startup dependency check failed, retrying");
      await sleep(input.retryDelayMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
