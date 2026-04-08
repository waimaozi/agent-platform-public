import { randomUUID } from "node:crypto";
import { EventEnvelope } from "@agent-platform/contracts";

export function buildEventEnvelope(input: Omit<EventEnvelope, "id" | "createdAt">): EventEnvelope {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...input
  };
}
