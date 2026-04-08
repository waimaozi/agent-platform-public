import { MemoryScopeType as PrismaMemoryScopeType, MemoryStatus as PrismaMemoryStatus, PrismaClient } from "@prisma/client";
import {
  ConsolidateOptions,
  ConsolidationResult,
  MemoryItem,
  MemoryQuery,
  MemoryScopeType,
  MemoryStatus
} from "@agent-platform/contracts";
import { prisma } from "@agent-platform/core";

export interface CreateCandidateInput {
  scopeType: MemoryScopeType;
  scopeId?: string;
  memoryType: string;
  content: string;
  summary?: string;
  sourceEventIds?: string[];
  confidence?: number;
  importance?: number;
  ttlPolicy?: string;
  userId?: string;
  projectId?: string;
  taskId?: string;
  evidenceRefs?: string[];
}

export interface MemoryFabric {
  createCandidate(input: CreateCandidateInput): Promise<MemoryItem>;
  createDurable(input: CreateCandidateInput): Promise<MemoryItem>;
  consolidate(options?: ConsolidateOptions): Promise<ConsolidationResult>;
  query(query: MemoryQuery): Promise<MemoryItem[]>;
  pin(userId: string, content: string, scopeId?: string, memoryType?: string): Promise<MemoryItem>;
  forget(memoryId: string): Promise<void>;
  getByScope(scopeType: MemoryScopeType, scopeId: string): Promise<MemoryItem[]>;
}

export class PrismaMemoryFabric implements MemoryFabric {
  constructor(private readonly db: PrismaClient = prisma) {}

  async createCandidate(input: CreateCandidateInput): Promise<MemoryItem> {
    return this.createMemoryRecord(input, "candidate");
  }

  async createDurable(input: CreateCandidateInput): Promise<MemoryItem> {
    return this.createMemoryRecord(input, "durable");
  }

  async consolidate(options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
    const olderThanMinutes = options.olderThanMinutes ?? 5;
    const now = options.now ? new Date(options.now) : new Date();
    const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
    const candidates = await this.db.memoryItem.findMany({
      where: {
        status: "candidate",
        createdAt: { lte: cutoff }
      },
      orderBy: { createdAt: "asc" }
    });

    let promoted = 0;
    let superseded = 0;
    const seen = new Map<string, string>();

    for (const candidate of candidates) {
      const normalized = normalizeContent(candidate.content);
      const existingDurable = await this.db.memoryItem.findFirst({
        where: {
          id: { not: candidate.id },
          scopeType: candidate.scopeType,
          scopeId: candidate.scopeId,
          status: "durable"
        },
        orderBy: { createdAt: "asc" }
      });

      const duplicateId = seen.get(normalized) ?? existingDurable?.id;
      if (duplicateId) {
        await this.db.memoryItem.update({
          where: { id: candidate.id },
          data: {
            status: "superseded",
            supersedesId: duplicateId
          }
        });
        superseded += 1;
        continue;
      }

      await this.db.memoryItem.update({
        where: { id: candidate.id },
        data: { status: "durable" }
      });
      promoted += 1;
      seen.set(normalized, candidate.id);
    }

    const forgotten = await this.applyTtl(now);

    return {
      scanned: candidates.length,
      promoted,
      superseded,
      forgotten
    };
  }

  async query(query: MemoryQuery): Promise<MemoryItem[]> {
    const records = await this.db.memoryItem.findMany({
      where: {
        userId: query.userId,
        scopeType: query.scopeType as PrismaMemoryScopeType | undefined,
        scopeId: query.scopeId,
        status: query.status ? (query.status as PrismaMemoryStatus) : undefined,
        taskId: query.taskId,
        projectId: query.projectId,
        content: query.searchText
          ? {
              contains: query.searchText,
              mode: "insensitive"
            }
          : undefined
      },
      orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
      take: query.limit ?? 20
    });

    return records.map(toMemoryItem);
  }

  async pin(userId: string, content: string, scopeId?: string, memoryType = "pinned_fact"): Promise<MemoryItem> {
    const record = await this.db.memoryItem.create({
      data: {
        userId,
        scopeType: "pinned",
        scopeId,
        memoryType,
        content,
        confidence: 0.95,
        importance: 1,
        status: "durable",
        ttlPolicy: "manual"
      }
    });

    return toMemoryItem(record);
  }

  async forget(memoryId: string): Promise<void> {
    await this.db.memoryItem.update({
      where: { id: memoryId },
      data: { status: "forgotten" }
    });
  }

  async getByScope(scopeType: MemoryScopeType, scopeId: string): Promise<MemoryItem[]> {
    const records = await this.db.memoryItem.findMany({
      where: {
        scopeType: scopeType as PrismaMemoryScopeType,
        scopeId,
        status: { not: "forgotten" }
      },
      orderBy: [{ importance: "desc" }, { updatedAt: "desc" }]
    });

    return records.map(toMemoryItem);
  }

  private async createMemoryRecord(input: CreateCandidateInput, status: "candidate" | "durable"): Promise<MemoryItem> {
    const record = await this.db.memoryItem.create({
      data: {
        scopeType: input.scopeType as PrismaMemoryScopeType,
        scopeId: input.scopeId,
        memoryType: input.memoryType,
        content: input.content,
        summary: input.summary,
        sourceEventIds: input.sourceEventIds ?? [],
        confidence: input.confidence ?? 0.5,
        importance: input.importance ?? 0.5,
        status,
        ttlPolicy: input.ttlPolicy ?? defaultTtlPolicy(input.scopeType),
        userId: input.userId,
        projectId: input.projectId,
        taskId: input.taskId,
        evidenceRefs: input.evidenceRefs ?? []
      }
    });

    return toMemoryItem(record);
  }

  private async applyTtl(now: Date): Promise<number> {
    const junkCutoff = new Date(now.getTime() - 60 * 60_000);
    const scratchpadCutoff = new Date(now.getTime() - 24 * 60 * 60_000);

    const junkResult = await this.db.memoryItem.updateMany({
      where: {
        scopeType: "junk",
        status: { in: ["candidate", "durable"] },
        createdAt: { lte: junkCutoff }
      },
      data: { status: "forgotten" }
    });

    const scratchpadResult = await this.db.memoryItem.updateMany({
      where: {
        scopeType: "session_scratchpad",
        status: { in: ["candidate", "durable"] },
        createdAt: { lte: scratchpadCutoff }
      },
      data: { status: "forgotten" }
    });

    return junkResult.count + scratchpadResult.count;
  }
}

function defaultTtlPolicy(scopeType: MemoryScopeType): string | undefined {
  if (scopeType === "junk") {
    return "forget_after_1h";
  }

  if (scopeType === "session_scratchpad") {
    return "forget_after_24h";
  }

  return undefined;
}

function normalizeContent(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toMemoryItem(record: {
  id: string;
  scopeType: PrismaMemoryScopeType;
  scopeId: string | null;
  memoryType: string;
  content: string;
  summary: string | null;
  sourceEventIds: string[];
  confidence: number;
  importance: number;
  status: PrismaMemoryStatus;
  ttlPolicy: string | null;
  supersedesId: string | null;
  conflictsWith: string[];
  evidenceRefs: string[];
  embedding: number[];
  userId: string | null;
  projectId: string | null;
  taskId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MemoryItem {
  return {
    id: record.id,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    memoryType: record.memoryType,
    content: record.content,
    summary: record.summary,
    sourceEventIds: record.sourceEventIds,
    confidence: record.confidence,
    importance: record.importance,
    status: record.status,
    ttlPolicy: record.ttlPolicy,
    supersedesId: record.supersedesId,
    conflictsWith: record.conflictsWith,
    evidenceRefs: record.evidenceRefs,
    embedding: record.embedding,
    userId: record.userId,
    projectId: record.projectId,
    taskId: record.taskId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  };
}
