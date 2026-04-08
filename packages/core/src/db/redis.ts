import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const RedisClient = Redis as unknown as typeof import("ioredis").default;

export const redisConnection = new RedisClient(redisUrl, {
  maxRetriesPerRequest: null
});
