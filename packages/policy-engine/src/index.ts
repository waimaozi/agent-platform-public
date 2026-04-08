import { BudgetPolicy } from "@agent-platform/contracts";

export interface BudgetSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  totalWallTimeMs: number;
  modelBreakdown: Record<string, number>;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reachedWarning: boolean;
  requiresHumanDecision: boolean;
  hardStop: boolean;
  utilizationPercent: number;
}

export function checkBudget(policy: BudgetPolicy, snapshot: BudgetSnapshot): BudgetCheckResult {
  const utilizationPercent = policy.maxTaskCostUsd === 0
    ? 0
    : (snapshot.totalEstimatedCostUsd / policy.maxTaskCostUsd) * 100;

  return {
    allowed: utilizationPercent < policy.stopAtPercent,
    reachedWarning: utilizationPercent >= policy.warnAtPercent,
    requiresHumanDecision: utilizationPercent >= 90 && utilizationPercent < policy.stopAtPercent,
    hardStop: utilizationPercent >= policy.stopAtPercent,
    utilizationPercent
  };
}

export function requiresApprovalForTask(input: {
  state: string;
  normalizedInput: string;
}): boolean {
  const text = input.normalizedInput.toLowerCase();
  return (
    text.includes("deploy") ||
    text.includes("migration") ||
    text.includes("approve") ||
    text.includes("send email") ||
    text.includes("отправь письмо") ||
    text.includes("напиши письмо")
  );
}
