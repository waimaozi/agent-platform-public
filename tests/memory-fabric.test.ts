import { describe, expect, it } from "vitest";
import { PrismaMemoryFabric } from "@agent-platform/memory-fabric";

describe("PrismaMemoryFabric", () => {
  it("creates candidates, consolidates, pins, forgets, and queries by scope", async () => {
    const db = createMemoryDb();
    const fabric = new PrismaMemoryFabric(db as never);

    const candidate = await fabric.createCandidate({
      userId: "user-1",
      scopeType: "task",
      scopeId: "thread-1",
      memoryType: "note",
      content: "Fix webhook retries",
      confidence: 0.7,
      importance: 0.8,
      sourceEventIds: ["event-1"]
    });

    await fabric.createCandidate({
      userId: "user-1",
      scopeType: "task",
      scopeId: "thread-1",
      memoryType: "note",
      content: "Fix webhook retries",
      sourceEventIds: ["event-2"]
    });

    db.memoryItems.forEach((item) => {
      item.createdAt = new Date(Date.now() - 10 * 60_000);
    });

    const consolidation = await fabric.consolidate();
    const pinned = await fabric.pin("user-1", "Use pnpm for scripts", "thread-1");
    await fabric.forget(pinned.id);
    const byScope = await fabric.getByScope("task", "thread-1");
    const queried = await fabric.query({ userId: "user-1", scopeType: "task", scopeId: "thread-1" });

    expect(candidate.status).toBe("candidate");
    expect(consolidation).toEqual({
      scanned: 2,
      promoted: 1,
      superseded: 1,
      forgotten: 0
    });
    expect(byScope).toHaveLength(2);
    expect(queried.some((item) => item.status === "durable")).toBe(true);
    expect(db.memoryItems.find((item) => item.id === pinned.id)?.status).toBe("forgotten");
  });
});

function createMemoryDb() {
  const memoryItems: Array<Record<string, any>> = [];

  return {
    memoryItems,
    memoryItem: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const record = {
          id: `memory-${memoryItems.length + 1}`,
          summary: null,
          sourceEventIds: [],
          confidence: 0.5,
          importance: 0.5,
          status: "candidate",
          ttlPolicy: null,
          supersedesId: null,
          conflictsWith: [],
          evidenceRefs: [],
          embedding: [],
          userId: null,
          projectId: null,
          taskId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        };
        memoryItems.push(record);
        return record;
      },
      findMany: async ({ where, orderBy, take }: { where: Record<string, any>; orderBy?: Array<Record<string, string>>; take?: number }) => {
        let result = memoryItems.filter((item) => matchesWhere(item, where));
        const ordering = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        if (ordering.length > 0) {
          result = [...result].sort((left, right) => {
            for (const entry of ordering) {
              const [key, direction] = Object.entries(entry)[0];
              const leftValue = left[key];
              const rightValue = right[key];
              if (leftValue === rightValue) {
                continue;
              }
              const sign = direction === "desc" ? -1 : 1;
              return leftValue > rightValue ? sign : -sign;
            }
            return 0;
          });
        }
        return typeof take === "number" ? result.slice(0, take) : result;
      },
      findFirst: async ({ where, orderBy }: { where: Record<string, any>; orderBy?: Record<string, string> }) => {
        const result = memoryItems.filter((item) => matchesWhere(item, where));
        if (!orderBy) {
          return result[0] ?? null;
        }
        const [key, direction] = Object.entries(orderBy)[0];
        return [...result].sort((left, right) => {
          const sign = direction === "desc" ? -1 : 1;
          return left[key] > right[key] ? sign : -sign;
        })[0] ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const record = memoryItems.find((item) => item.id === where.id);
        if (!record) {
          throw new Error("missing memory");
        }
        Object.assign(record, data, { updatedAt: new Date() });
        return record;
      },
      updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const matches = memoryItems.filter((item) => matchesWhere(item, where));
        matches.forEach((item) => Object.assign(item, data, { updatedAt: new Date() }));
        return { count: matches.length };
      }
    }
  };
}

function matchesWhere(item: Record<string, any>, where: Record<string, any> | undefined): boolean {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("lte" in value) {
        return item[key] <= value.lte;
      }
      if ("not" in value) {
        return item[key] !== value.not;
      }
      if ("in" in value) {
        return value.in.includes(item[key]);
      }
      if ("contains" in value) {
        return String(item[key]).toLowerCase().includes(String(value.contains).toLowerCase());
      }
    }
    return item[key] === value;
  });
}
