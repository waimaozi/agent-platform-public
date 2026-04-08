import { Worker } from "bullmq";
import { TASK_QUEUE_NAME, appendTaskEvent, getTaskQueue, prisma, redisConnection, verifyStartupDependencies } from "@agent-platform/core";
import { CodexCliRuntime, MockCodexRuntime } from "@agent-platform/codex-runtime";
import {
  formatTaskFailed,
  formatTaskProgress,
  HttpN8nClient,
  resolveSmtpPassword,
  SmtpEmailClient,
  TelegramClient
} from "@agent-platform/integrations";
import { PrismaMemoryFabric } from "@agent-platform/memory-fabric";
import type { MemoryFabric } from "@agent-platform/memory-fabric";
import { createLogger } from "@agent-platform/observability";
import { PrismaSecretsService } from "@agent-platform/secrets-service";
import { runSupervisor } from "@agent-platform/supervisor";
import { ClaudeCodeSupervisorRuntime, MockSupervisorRuntime } from "@agent-platform/supervisor-runtime";
import { runMiraCheckinJob } from "./checkin-job.js";
import { reportTaskError } from "./error-reporter.js";
import { buildFinalTelegramMessage } from "./final-task-message.js";
import { cleanupStuckTasksOnStartup } from "./stuck-task-cleanup.js";
import { startTelegramTypingIndicator } from "./typing-indicator.js";

const logger = createLogger().child({ service: "worker" });
const telegramClient = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? "");
const claudeCodePath = process.env.CLAUDE_CODE_PATH ?? "claude";
const codexPath = process.env.CODEX_PATH ?? "codex";
const useRealSupervisor = (process.env.USE_REAL_SUPERVISOR ?? "false") === "true";
const useRealCoder = (process.env.USE_REAL_CODER ?? "false") === "true";
const scopedMemoryEnabled = (process.env.FEATURE_SCOPED_MEMORY ?? "false") === "true";
const supervisorRuntime = useRealSupervisor
  ? new ClaudeCodeSupervisorRuntime({ command: claudeCodePath, timeoutMs: 120_000 })
  : new MockSupervisorRuntime();
const coderRuntime = useRealCoder
  ? new CodexCliRuntime({
      command: codexPath,
      timeoutMs: 10 * 60 * 1000,
      cwd: "/home/openclaw/agent-platform"
    })
  : new MockCodexRuntime();
const memoryFabric: MemoryFabric | null = scopedMemoryEnabled ? new PrismaMemoryFabric() : null;
const consolidationIntervalMs = 5 * 60 * 1000;

const consolidationTimer = memoryFabric
  ? setInterval(() => {
      void memoryFabric
        .consolidate()
        .then((result) => {
          logger.info(
            {
              scanned: result.scanned,
              promoted: result.promoted,
              superseded: result.superseded,
              forgotten: result.forgotten
            },
            "Scoped memory consolidation tick completed"
          );
        })
        .catch((error) => {
          logger.error({ err: error }, "Scoped memory consolidation tick failed");
        });
    }, consolidationIntervalMs)
  : null;

if (consolidationTimer) {
  for (const signal of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
    process.on(signal, () => {
      clearInterval(consolidationTimer);
    });
  }
}

async function sendTelegramUpdate(
  chatId: string,
  text: string,
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }
) {
  await telegramClient.sendMessage({
    chatId,
    text,
    parseMode: "MarkdownV2",
    replyMarkup
  });
}

async function createSupervisorApproval(taskId: string) {
  return prisma.approval.create({
    data: {
      taskId,
      reason: "Supervisor plan requires approval before execution.",
      requestedBy: "supervisor",
      status: "pending"
    }
  });
}

function getTaskChatId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const chatId = (metadata as Record<string, unknown>).chatId;
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
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

function formatApprovalRequired(taskId: string): string {
  void taskId;
  return [
    "*Нужно подтверждение*",
    "Подтверди, чтобы я продолжила выполнение задачи."
  ].join("\n");
}

function toCostSnapshot(snapshot: {
  totalEstimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalWallTimeMs: number;
  modelBreakdownJson: unknown;
} | null | undefined) {
  if (!snapshot) {
    return null;
  }

  return {
    totalEstimatedCostUsd: snapshot.totalEstimatedCostUsd,
    totalInputTokens: snapshot.totalInputTokens,
    totalOutputTokens: snapshot.totalOutputTokens,
    totalWallTimeMs: snapshot.totalWallTimeMs,
    modelBreakdownJson: toModelBreakdown(snapshot.modelBreakdownJson)
  };
}

function toModelBreakdown(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, amount]) =>
      typeof amount === "number" ? [[key, amount] as const] : []
    )
  );
}

function toContextBundle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const bundle = value as {
    sections?: Array<{ name?: unknown; content?: unknown; source?: unknown; tokens?: unknown }>;
    retrievalTrace?: Array<{ source?: unknown; reason?: unknown; memoryItemId?: unknown; rawEventId?: unknown; score?: unknown }>;
    totalTokens?: unknown;
  };

  return {
    sections: Array.isArray(bundle.sections)
      ? bundle.sections.flatMap((section) => {
          if (
            !section ||
            typeof section !== "object" ||
            typeof section.name !== "string" ||
            typeof section.content !== "string" ||
            typeof section.source !== "string" ||
            typeof section.tokens !== "number"
          ) {
            return [];
          }

          return [
            {
              name: section.name,
              content: section.content,
              source: section.source,
              tokens: section.tokens
            }
          ];
        })
      : [],
    retrievalTrace: Array.isArray(bundle.retrievalTrace)
      ? bundle.retrievalTrace.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || typeof entry.source !== "string" || typeof entry.reason !== "string") {
            return [];
          }

          return [
            {
              source: entry.source,
              reason: entry.reason,
              memoryItemId: typeof entry.memoryItemId === "string" ? entry.memoryItemId : undefined,
              rawEventId: typeof entry.rawEventId === "string" ? entry.rawEventId : undefined,
              score: typeof entry.score === "number" ? entry.score : undefined
            }
          ];
        })
      : [],
    totalTokens: typeof bundle.totalTokens === "number" ? bundle.totalTokens : 0
  };
}

async function startWorker() {
  await verifyStartupDependencies("worker", logger);

  void cleanupStuckTasksOnStartup({ logger }).catch((error) => {
    logger.error({ err: error }, "Worker startup stuck task cleanup failed");
  });

  if (scopedMemoryEnabled) {
    const queue = getTaskQueue();
    void queue.add(
      "mira-checkin",
      {},
      {
        jobId: "mira-checkin",
        repeat: {
          every: 4 * 60 * 60 * 1000
        },
        removeOnComplete: 20,
        removeOnFail: 20
      }
    ).catch((error) => {
      logger.error({ err: error }, "Failed to register mira-checkin repeatable job");
    });
  }

  const worker = new Worker(
    TASK_QUEUE_NAME,
    async (job) => {
      if (job.name === "mira-checkin") {
        if (!scopedMemoryEnabled) {
          return;
        }

        await runMiraCheckinJob();
        return;
      }

      const { taskId, resumeAfterApproval } = job.data as { taskId: string; resumeAfterApproval?: boolean };
      logger.info({ taskId }, "Running supervisor job");

      const initialTask = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        select: {
          state: true,
          metadata: true
        }
      });
      const chatId = getTaskChatId(initialTask.metadata);
      const stopTyping = chatId
        ? startTelegramTypingIndicator({ chatId, telegramClient })
        : null;

      try {
        const secretsService = maybeCreateSecretsService();
        const smtpPass = await resolveSmtpPassword(secretsService ?? undefined);
        const contextBundleRecord = await prisma.contextBundle.findFirst({
          where: { taskId },
          orderBy: { createdAt: "desc" }
        });

        await runSupervisor(taskId, {
          supervisorRuntime,
          coderRuntime,
          emailClient: new SmtpEmailClient({ pass: smtpPass }),
          n8nClient: new HttpN8nClient(
            process.env.N8N_BASE_URL ?? "https://n8n2.waimaozi.com",
            process.env.N8N_API_KEY
          ),
          contextBundle: toContextBundle(contextBundleRecord?.bundleJson),
          resumeAfterApproval: (resumeAfterApproval ?? false) || initialTask.state === "RUNNING",
          onStatusUpdate: async (stage) => {
            if (!chatId) {
              return;
            }

            await sendTelegramUpdate(chatId, formatTaskProgress(stage, taskId));
          }
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown worker error";

        if (chatId) {
          await sendTelegramUpdate(chatId, formatTaskFailed(reason, taskId));
        }

        throw error;
      } finally {
        stopTyping?.();
      }

      const task = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        include: {
          approvals: {
            where: { status: "pending" },
            orderBy: { createdAt: "desc" },
            take: 1
          },
          costSnapshots: {
            orderBy: { createdAt: "desc" },
            take: 1
          },
          taskEvents: {
            orderBy: { createdAt: "asc" }
          }
        }
      });

      const finalChatId = getTaskChatId(task.metadata);

      if (!finalChatId) {
        return;
      }

      if (task.state === "AWAITING_APPROVAL") {
        const pendingApproval = task.approvals[0] ?? (await createSupervisorApproval(taskId));

        await sendTelegramUpdate(
          finalChatId,
          formatApprovalRequired(taskId),
          {
            inline_keyboard: [
              [
                {
                  text: "Approve",
                  callback_data: `approval:${pendingApproval.id}:approve`
                },
                {
                  text: "Reject",
                  callback_data: `approval:${pendingApproval.id}:reject`
                }
              ]
            ]
          }
        );
        return;
      }

      const finalMessage = buildFinalTelegramMessage({
        state: task.state,
        taskEvents: task.taskEvents,
        costSnapshots: task.costSnapshots.flatMap((snapshot) => toCostSnapshot(snapshot) ?? [])
      });

      if (finalMessage) {
        await sendTelegramUpdate(finalChatId, finalMessage);
      }
    },
    {
      connection: redisConnection
    }
  );

  worker.on("completed", (job) => {
    logger.info({ taskId: job.data.taskId }, "Supervisor job completed");
  });

  worker.on("failed", (job, error) => {
    const taskId = typeof job?.data?.taskId === "string" ? job.data.taskId : null;
    const message = error instanceof Error ? error.message : String(error);

    logger.error({ taskId, err: error }, "Supervisor job failed");

    if (!taskId) {
      return;
    }

    void prisma.task.findUnique({
      where: { id: taskId },
      select: { metadata: true }
    }).then((task) => {
      const chatId = getTaskChatId(task?.metadata);

      return Promise.all([
        appendTaskEvent({
          taskId,
          type: "task.error_reported",
          actor: "system",
          payload: {
            error: message,
            sourceChatId: chatId,
            reportedToChatId:
              process.env.TELEGRAM_ADMIN_CHAT_ID ?? process.env.TELEGRAM_BOOTSTRAP_CHAT_ID ?? null
          }
        }),
        reportTaskError(taskId, message, chatId ?? "")
      ]);
    }).catch((reportError) => {
      logger.error({ taskId, err: reportError }, "Failed to report task error to Mira admin chat");
    });
  });
}

void startWorker().catch((error) => {
  logger.error({ err: error }, "Worker startup failed");
  process.exit(1);
});
