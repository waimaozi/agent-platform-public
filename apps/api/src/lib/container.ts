import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { assertTransition, getTaskQueue, prisma, transitionTaskState } from "@agent-platform/core";
import { HttpN8nClient, resolveSmtpPassword, SmtpEmailClient, TelegramClient } from "@agent-platform/integrations";
import { createLogger } from "@agent-platform/observability";
import { requiresApprovalForTask } from "@agent-platform/policy-engine";
import { PrismaSecretsService } from "@agent-platform/secrets-service";
import { resolveApprovalDecision } from "./approval-flow.js";

export interface AppContainer {
  logger: ReturnType<typeof createLogger>;
  telegramClient: TelegramClient;
  emailClient: SmtpEmailClient;
  n8nClient: HttpN8nClient;
}

export async function buildContainer(): Promise<AppContainer> {
  const secretsService = maybeCreateSecretsService();
  const smtpPass = await resolveSmtpPassword(secretsService ?? undefined);

  return {
    logger: createLogger(),
    telegramClient: new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? ""),
    emailClient: new SmtpEmailClient({ pass: smtpPass }),
    n8nClient: new HttpN8nClient(
      process.env.N8N_BASE_URL ?? "https://n8n2.waimaozi.com",
      process.env.N8N_API_KEY
    )
  };
}

function maybeCreateSecretsService() {
  try {
    if (!process.env.SECRETS_ENCRYPTION_KEY) {
      return null;
    }

    return new PrismaSecretsService();
  } catch {
    return null;
  }
}

export async function ensureDefaultBudgetPolicy() {
  const existing = await prisma.budgetPolicy.findFirst({
    where: { isDefault: true }
  });

  if (existing) {
    return existing;
  }

  return prisma.budgetPolicy.create({
    data: {
      name: "default-mvp",
      isDefault: true,
      maxTaskCostUsd: 10,
      maxTaskTokens: 250000,
      maxOpusCalls: 10,
      maxCodexRuns: 5,
      maxWallTimeMinutes: 60,
      warnAtPercent: 75,
      stopAtPercent: 100
    }
  });
}

export async function findOrCreateUser(input: {
  telegramUserId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}) {
  return prisma.user.upsert({
    where: { externalId_channel: { externalId: input.telegramUserId, channel: "telegram" } },
    update: {
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName
    },
    create: {
      externalId: input.telegramUserId,
      channel: "telegram",
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
      userProfile: {
        create: {
          language: "ru",
          verbosity: "medium",
          costSensitivity: "medium",
          latencySensitivity: "medium",
          autonomyPreference: "balanced",
          notifyStyle: "major_only",
          preferredRoutingProfile: "balanced"
        }
      }
    }
  });
}

export function normalizeTaskInput(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export async function createTaskCostSnapshot(taskId: string) {
  return prisma.taskCostSnapshot.create({
    data: {
      taskId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
      totalWallTimeMs: 0,
      modelBreakdownJson: {}
    }
  });
}

export async function enqueueTask(taskId: string, options?: { resumeAfterApproval?: boolean }) {
  const queue = getTaskQueue();
  const jobSuffix = options?.resumeAfterApproval ? `:resume:${Date.now()}` : "";
  await queue.add(
    "supervise-task",
    { taskId, resumeAfterApproval: options?.resumeAfterApproval ?? false },
    {
      jobId: `${taskId}${jobSuffix}`,
      removeOnComplete: 100,
      removeOnFail: 100
    }
  );
}

export async function createApproval(input: {
  taskId: string;
  reason: string;
  requestedBy: "system" | "supervisor";
}) {
  return prisma.approval.create({
    data: {
      taskId: input.taskId,
      reason: input.reason,
      requestedBy: input.requestedBy,
      status: "pending"
    }
  });
}

export async function createInitialTaskArtifacts(input: {
  userId: string;
  chatId: string;
  rawInput: string;
  projectProfileId?: string | null;
  metadata?: Prisma.JsonObject;
  autoEnqueue?: boolean;
}) {
  const budgetPolicy = await ensureDefaultBudgetPolicy();
  const normalizedInput = normalizeTaskInput(input.rawInput);
  const autoEnqueue = input.autoEnqueue ?? true;

  const task = await prisma.task.create({
    data: {
      userId: input.userId,
      channel: "telegram",
      threadId: input.chatId,
      title: normalizedInput.slice(0, 120),
      rawInput: input.rawInput,
      normalizedInput,
      state: "NEW",
      budgetPolicyId: budgetPolicy.id,
      projectProfileId: input.projectProfileId,
      metadata: {
        requestId: randomUUID(),
        chatId: input.chatId,
        ...(input.metadata ?? {})
      },
      taskEvents: {
        create: {
          type: "task.created",
          actor: "user",
          payload: { rawInput: input.rawInput }
        }
      }
    }
  });

  await transitionTaskState(task.id, "INTAKE_NORMALIZED");
  await prisma.taskEvent.create({
    data: {
      taskId: task.id,
      type: "task.normalized",
      actor: "system",
      payload: { normalizedInput }
    }
  });

  await createTaskCostSnapshot(task.id);

  const approvalNeeded = requiresApprovalForTask({
    state: task.state,
    normalizedInput
  });

  if (approvalNeeded) {
    await transitionTaskState(task.id, "PLANNING");
    await transitionTaskState(task.id, "AWAITING_APPROVAL");
    await prisma.taskEvent.create({
      data: {
        taskId: task.id,
        type: "approval.requested",
        actor: "system",
        payload: { reason: "Policy trigger keywords matched" }
      }
    });

    const approval = await createApproval({
      taskId: task.id,
      reason: "Task matched approval policy",
      requestedBy: "system"
    });

    return {
      taskId: task.id,
      approvalId: approval.id,
      approvalNeeded: true
    };
  }

  if (autoEnqueue) {
    await enqueueTask(task.id);
  }

  return {
    taskId: task.id,
    approvalNeeded: false
  };
}

export async function applyApprovalDecision(input: {
  approvalId: string;
  decision: "approve" | "reject";
  decidedByUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const approval = await tx.approval.findUnique({
      where: { id: input.approvalId },
      include: { task: true }
    });

    if (!approval) {
      return {
        applied: false,
        error: "Approval not found"
      };
    }

    if (approval.status !== "pending") {
      return {
        applied: false,
        error: "Approval already processed",
        approvalId: approval.id,
        taskId: approval.taskId,
        status: approval.status,
        taskState: approval.task.state
      };
    }

    const resolution = resolveApprovalDecision({
      currentStatus: approval.status,
      decision: input.decision
    });

    if (!resolution) {
      return {
        applied: false,
        approvalId: approval.id,
        taskId: approval.taskId,
        status: approval.status,
        taskState: approval.task.state
      };
    }

    assertTransition(approval.task.state, resolution.taskState);

    await tx.approval.update({
      where: { id: approval.id },
      data: {
        status: resolution.approvalStatus,
        decision: input.decision,
        decidedByUserId: input.decidedByUserId,
        decidedAt: new Date()
      }
    });

    await tx.task.update({
      where: { id: approval.taskId },
      data: {
        state: resolution.taskState,
        taskEvents: {
          create: [
            {
              type: "approval.received",
              actor: "user",
              payload: {
                approvalId: approval.id,
                decision: input.decision
              } satisfies Prisma.JsonObject
            },
            {
              type: input.decision === "approve" ? "task.resumed" : "task.cancelled",
              actor: "system",
              payload: { reason: `Approval ${input.decision}` }
            }
          ]
        }
      }
    });

    return {
      applied: true,
      approvalId: approval.id,
      taskId: approval.taskId,
      status: resolution.approvalStatus,
      taskState: resolution.taskState
    };
  });
}
