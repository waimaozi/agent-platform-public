import { Actor } from "@agent-platform/contracts";
import { prisma } from "@agent-platform/core";

export interface PricingCatalogEntry {
  provider: string;
  model: string;
  pricingVersion: string;
  inputCostPer1m: number;
  outputCostPer1m: number;
  cachedInputDiscount: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface LlmCallLogInput {
  taskId?: string;
  subagentId: string;
  actor?: Actor;
  provider: string;
  model: string;
  purpose?: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  latencyMs: number;
  estimatedCostUsd?: number;
}

export interface PricingCatalog {
  getEntry(provider: string, model: string): Promise<PricingCatalogEntry | null>;
}

export interface LlmCallLogger {
  record(input: LlmCallLogInput): Promise<{ estimatedCostUsd: number }>;
}

export interface TaskCostSnapshotUpdaterInput {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  wallTimeMs: number;
  modelKey: string;
}

export interface TaskCostSnapshotUpdater {
  applyUsage(input: TaskCostSnapshotUpdaterInput): Promise<void>;
}

export function estimateCostUsd(entry: PricingCatalogEntry, input: LlmCallLogInput): number {
  const inputBillable = Math.max(input.promptTokens - input.cachedTokens, 0);
  const cachedBillable = input.cachedTokens * entry.cachedInputDiscount;

  return Number(
    (
      (inputBillable / 1_000_000) * entry.inputCostPer1m +
      (cachedBillable / 1_000_000) * entry.inputCostPer1m +
      (input.completionTokens / 1_000_000) * entry.outputCostPer1m
    ).toFixed(6)
  );
}

export class StaticPricingCatalog implements PricingCatalog {
  constructor(private readonly entries: PricingCatalogEntry[]) {}

  async getEntry(provider: string, model: string): Promise<PricingCatalogEntry | null> {
    return this.entries.find((entry) => entry.provider === provider && entry.model === model) ?? null;
  }
}

export class PrismaLlmCallLogger implements LlmCallLogger {
  constructor(private readonly pricingCatalog: PricingCatalog) {}

  async record(input: LlmCallLogInput): Promise<{ estimatedCostUsd: number }> {
    const pricing = await this.pricingCatalog.getEntry(input.provider, input.model);
    const estimatedCostUsd =
      typeof input.estimatedCostUsd === "number"
        ? input.estimatedCostUsd
        : pricing
          ? estimateCostUsd(pricing, input)
          : 0;

    await prisma.llmCallLog.create({
      data: {
        subagentId: input.subagentId,
        actor: input.actor,
        provider: input.provider,
        model: input.model,
        purpose: input.purpose,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        cachedTokens: input.cachedTokens,
        latencyMs: input.latencyMs,
        estimatedCostUsd,
        startedAt: new Date(Date.now() - input.latencyMs),
        finishedAt: new Date(),
        ...(input.taskId
          ? {
              task: {
                connect: { id: input.taskId }
              }
            }
          : {})
      }
    });

    return { estimatedCostUsd };
  }
}

export class PrismaTaskCostSnapshotUpdater implements TaskCostSnapshotUpdater {
  async applyUsage(input: TaskCostSnapshotUpdaterInput): Promise<void> {
    const latest = await prisma.taskCostSnapshot.findFirst({
      where: { taskId: input.taskId },
      orderBy: { createdAt: "desc" }
    });

    const modelBreakdown = ((latest?.modelBreakdownJson as Record<string, number> | null) ?? {});

    await prisma.taskCostSnapshot.create({
      data: {
        taskId: input.taskId,
        totalInputTokens: (latest?.totalInputTokens ?? 0) + input.inputTokens,
        totalOutputTokens: (latest?.totalOutputTokens ?? 0) + input.outputTokens,
        totalEstimatedCostUsd: Number(((latest?.totalEstimatedCostUsd ?? 0) + input.estimatedCostUsd).toFixed(6)),
        totalWallTimeMs: (latest?.totalWallTimeMs ?? 0) + input.wallTimeMs,
        modelBreakdownJson: {
          ...modelBreakdown,
          [input.modelKey]: Number((((modelBreakdown[input.modelKey] ?? 0) + input.estimatedCostUsd)).toFixed(6))
        }
      }
    });
  }
}
