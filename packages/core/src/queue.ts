import { Queue } from "bullmq";
import { redisConnection } from "./db/redis.js";

export const TASK_QUEUE_NAME = "task-supervisor";

export function getTaskQueue(): Queue {
  return new Queue(TASK_QUEUE_NAME, {
    connection: redisConnection
  });
}
