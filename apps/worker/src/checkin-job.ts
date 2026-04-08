import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma, PrismaClient, TaskState } from "@prisma/client";
import { appendTaskEvent, prisma } from "@agent-platform/core";
import { TelegramClient } from "@agent-platform/integrations";

export interface CheckinHeuristicsResult {
  shouldPing: boolean;
  reasons: string[];
  summary: {
    completed: number;
    failed: number;
    pending: number;
  };
  stuckTasks: Array<{ id: string; title: string; ageMinutes: number }>;
  deadlines: Array<{ name: string; deadline: Date }>;
  hoursSinceActivity: number | null;
}

export interface FailurePatternAlert {
  pattern: string;
  count: number;
  hypothesis: string;
  suggestedFix: string;
}

export async function runAgentCheckinJob(
  input: {
    db?: PrismaClient;
    telegramClient?: Pick<TelegramClient, "sendMessage">;
    now?: Date;
    projectsPath?: string;
    bootstrapChatId?: string;
  } = {}
) {
  const db = input.db ?? prisma;
  const now = input.now ?? new Date();
  const projectsPath = input.projectsPath ?? resolve(process.cwd(), "docs/PROJECTS.md");
  const bootstrapChatId = input.bootstrapChatId ?? process.env.TELEGRAM_BOOTSTRAP_CHAT_ID ?? "";
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? bootstrapChatId;
  const telegramClient = input.telegramClient ?? new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? "");
  const recentSince = new Date(now.getTime() - 24 * 60 * 60_000);
  const tasks = await db.task.findMany({
    where: {
      createdAt: { gte: recentSince }
    },
    select: {
      id: true,
      title: true,
      state: true,
      createdAt: true,
      updatedAt: true,
      metadata: true
    },
    orderBy: { updatedAt: "desc" }
  });
  const visibleTasks = tasks.filter((task) => !isSystemInternal(task.metadata));
  const recentFailureEvents = await db.taskEvent.findMany({
    where: {
      type: "task.failed",
      createdAt: {
        gte: new Date(now.getTime() - 60 * 60_000)
      }
    },
    select: {
      taskId: true,
      payload: true,
      task: {
        select: {
          metadata: true
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  const pinnedMemory = await db.memoryItem.findMany({
    where: {
      scopeType: "pinned",
      status: "durable"
    },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: 10,
    select: {
      content: true,
      memoryType: true
    }
  });
  const projectsMarkdown = await readProjectsFile(projectsPath);
  const deadlines = await (db.projectProfile as any).findMany({
    where: {
      deadline: {
        gte: now,
        lte: new Date(now.getTime() + 3 * 24 * 60 * 60_000)
      },
      status: {
        in: ["active", "planning", "on_hold"]
      }
    },
    orderBy: { deadline: "asc" },
    select: {
      name: true,
      deadline: true
    },
    take: 5
  });

  const heuristics = evaluateCheckinHeuristics({
    tasks: visibleTasks,
    now,
    deadlines: deadlines.flatMap((project: any) =>
      project.deadline ? [{ name: project.name, deadline: project.deadline }] : []
    ),
    pinnedMemory: pinnedMemory.map((item) => `${item.memoryType}: ${item.content}`),
    projectsMarkdown
  });

  if (!heuristics.shouldPing || !bootstrapChatId) {
    const failureAlert = detectFailurePatternAlert(
      recentFailureEvents.flatMap((event) =>
        isSystemInternal(event.task.metadata)
          ? []
          : [{ taskId: event.taskId, error: extractFailureText(event.payload) }]
      )
    );

    if (failureAlert && adminChatId) {
      const taskId = await ensureCheckinEventTask(db);
      const failureMessage = composeFailurePatternMessage(failureAlert);

      await telegramClient.sendMessage({
        chatId: adminChatId,
        text: failureMessage
      });

      await appendTaskEvent({
        taskId,
        type: "agent.self_heal_alert",
        actor: "system",
        payload: {
          ...failureAlert,
          message: failureMessage
        } as Prisma.InputJsonValue
      });
    }

    return heuristics;
  }

  const message = composeCheckinMessage(heuristics);
  await telegramClient.sendMessage({
    chatId: bootstrapChatId,
    text: message
  });

  const taskId = await ensureCheckinEventTask(db);
  await appendTaskEvent({
    taskId,
    type: "agent.checkin",
    actor: "system",
    payload: {
      reasons: heuristics.reasons,
      summary: heuristics.summary,
      stuckTasks: heuristics.stuckTasks.map((task) => task.id),
      deadlines: heuristics.deadlines.map((deadline) => ({
        name: deadline.name,
        deadline: deadline.deadline.toISOString()
      })),
      message
    } as Prisma.InputJsonValue
  });

  const failureAlert = detectFailurePatternAlert(
    recentFailureEvents.flatMap((event) =>
      isSystemInternal(event.task.metadata)
        ? []
        : [{ taskId: event.taskId, error: extractFailureText(event.payload) }]
    )
  );

  if (failureAlert) {
    const failureMessage = composeFailurePatternMessage(failureAlert);
    await telegramClient.sendMessage({
      chatId: adminChatId,
      text: failureMessage
    });

    await appendTaskEvent({
      taskId,
      type: "agent.self_heal_alert",
      actor: "system",
      payload: {
        ...failureAlert,
        message: failureMessage
      } as Prisma.InputJsonValue
    });
  }

  return heuristics;
}

export function evaluateCheckinHeuristics(input: {
  tasks: Array<{ id: string; title: string; state: TaskState; createdAt: Date; updatedAt: Date }>;
  now: Date;
  deadlines: Array<{ name: string; deadline: Date }>;
  pinnedMemory: string[];
  projectsMarkdown: string;
}): CheckinHeuristicsResult {
  const completed = input.tasks.filter((task) => task.state === "COMPLETED").length;
  const failed = input.tasks.filter((task) => task.state === "FAILED").length;
  const pendingTasks = input.tasks.filter((task) => !["COMPLETED", "FAILED", "CANCELLED"].includes(task.state));
  const stuckTasks = pendingTasks
    .filter((task) => input.now.getTime() - task.updatedAt.getTime() > 30 * 60_000)
    .map((task) => ({
      id: task.id,
      title: task.title,
      ageMinutes: Math.round((input.now.getTime() - task.updatedAt.getTime()) / 60_000)
    }))
    .sort((left, right) => right.ageMinutes - left.ageMinutes);

  const lastActivityAt = input.tasks.reduce<Date | null>((latest, task) => {
    if (!latest || task.updatedAt > latest) {
      return task.updatedAt;
    }
    return latest;
  }, null);
  const hoursSinceActivity = lastActivityAt
    ? Number(((input.now.getTime() - lastActivityAt.getTime()) / 3_600_000).toFixed(1))
    : null;

  const reasons: string[] = [];
  if (stuckTasks.length > 0) {
    reasons.push(`${stuckTasks.length} stuck task${stuckTasks.length > 1 ? "s" : ""}`);
  }
  if (hoursSinceActivity !== null && hoursSinceActivity > 8) {
    reasons.push(`no activity for ${hoursSinceActivity}h`);
  }
  if (hoursSinceActivity === null && input.projectsMarkdown.trim()) {
    reasons.push("no task activity in the last 24h");
  }
  if (input.deadlines.length > 0) {
    reasons.push(`${input.deadlines.length} deadline${input.deadlines.length > 1 ? "s" : ""} within 3 days`);
  }

  return {
    shouldPing: reasons.length > 0,
    reasons,
    summary: {
      completed,
      failed,
      pending: pendingTasks.length
    },
    stuckTasks,
    deadlines: input.deadlines,
    hoursSinceActivity
  };
}

export function composeCheckinMessage(result: CheckinHeuristicsResult): string {
  const lines = [
    "Agent check-in",
    `24h tasks: ${result.summary.completed} completed, ${result.summary.failed} failed, ${result.summary.pending} pending`,
    `Why now: ${result.reasons.join("; ")}`
  ];

  if (result.stuckTasks.length > 0) {
    lines.push(`Stuck: ${result.stuckTasks.slice(0, 3).map((task) => `${task.title} (${task.ageMinutes}m)`).join(", ")}`);
  }
  if (result.deadlines.length > 0) {
    lines.push(
      `Deadlines: ${result.deadlines.map((deadline) => `${deadline.name} ${deadline.deadline.toISOString().slice(0, 10)}`).join(", ")}`
    );
  }

  return lines.join("\n");
}

const FAILURE_PATTERNS: Array<{
  match: RegExp;
  pattern: string;
  hypothesis: string;
  suggestedFix: string;
}> = [
  {
    match: /database does not exist/i,
    pattern: "Database does not exist",
    hypothesis: "База данных не создана или была пересоздана без нужного database/schema.",
    suggestedFix: "Пересоздать database/schema и проверить DATABASE_URL."
  },
  {
    match: /not logged in/i,
    pattern: "Not logged in",
    hypothesis: "OAuth или внешняя сессия истекла.",
    suggestedFix: "Обновить OAuth/login и проверить сохранённые credentials."
  },
  {
    match: /execution failed \(exit 1\)/i,
    pattern: "execution failed (exit 1)",
    hypothesis: "CLI-команда завершилась с ошибкой на уровне runtime или окружения.",
    suggestedFix: "Проверить stderr, команду запуска и доступность зависимостей CLI."
  },
  {
    match: /timeout/i,
    pattern: "timeout",
    hypothesis: "Задача слишком тяжёлая, либо модель/инструмент отвечает слишком медленно.",
    suggestedFix: "Разбить задачу на шаги или увеличить timeout для конкретного runtime."
  }
];

export function detectFailurePatternAlert(
  failures: Array<{ taskId: string; error: string | null | undefined }>
): FailurePatternAlert | null {
  const counts = new Map<string, FailurePatternAlert>();

  for (const failure of failures) {
    const normalized = normalizeFailurePattern(failure.error);
    if (!normalized) {
      continue;
    }

    const existing = counts.get(normalized.pattern);
    if (existing) {
      existing.count += 1;
      continue;
    }

    counts.set(normalized.pattern, {
      pattern: normalized.pattern,
      count: 1,
      hypothesis: normalized.hypothesis,
      suggestedFix: normalized.suggestedFix
    });
  }

  return [...counts.values()]
    .filter((entry) => entry.count > 3)
    .sort((left, right) => right.count - left.count)[0] ?? null;
}

export function composeFailurePatternMessage(alert: FailurePatternAlert): string {
  return [
    `За последний час ${alert.count} задач упало с ошибкой: ${alert.pattern}.`,
    `Возможная причина: ${alert.hypothesis}`,
    `Что проверить: ${alert.suggestedFix}`
  ].join("\n");
}

function normalizeFailurePattern(error: string | null | undefined) {
  if (!error) {
    return null;
  }

  const matched = FAILURE_PATTERNS.find((candidate) => candidate.match.test(error));
  return matched ?? null;
}

function extractFailureText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const reason = (payload as Record<string, unknown>).reason;
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }

  const verifier = (payload as Record<string, unknown>).verifier;
  if (verifier && typeof verifier === "object" && !Array.isArray(verifier)) {
    const summary = (verifier as Record<string, unknown>).summary;
    if (typeof summary === "string" && summary.length > 0) {
      return summary;
    }
  }

  const summary = (payload as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.length > 0 ? summary : null;
}

async function readProjectsFile(projectsPath: string) {
  try {
    return await readFile(projectsPath, "utf8");
  } catch {
    return "";
  }
}

async function ensureCheckinEventTask(db: PrismaClient): Promise<string> {
  const existing = await db.task.findFirst({
    where: {
      channel: "admin",
      threadId: "agent-checkin"
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });
  if (existing) {
    return existing.id;
  }

  const budgetPolicy = await db.budgetPolicy.findFirst({
    where: { isDefault: true },
    select: { id: true }
  });
  const policyId = budgetPolicy?.id ?? (
    await db.budgetPolicy.create({
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
      },
      select: { id: true }
    })
  ).id;
  const user = await db.user.upsert({
    where: {
      externalId_channel: {
        externalId: "agent-system",
        channel: "admin"
      }
    },
    update: {},
    create: {
      externalId: "agent-system",
      channel: "admin",
      username: "agent-system"
    },
    select: { id: true }
  });
  const task = await db.task.create({
    data: {
      userId: user.id,
      channel: "admin",
      threadId: "agent-checkin",
      title: "Agent proactive check-in log",
      rawInput: "agent-checkin",
      normalizedInput: "agent-checkin",
      state: "COMPLETED",
      budgetPolicyId: policyId,
      metadata: {
        systemInternal: true,
        kind: "agent-checkin"
      },
      taskEvents: {
        create: {
          type: "task.created",
          actor: "system",
          payload: { source: "agent-checkin" }
        }
      }
    },
    select: { id: true }
  });
  return task.id;
}

function isSystemInternal(metadata: unknown) {
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).systemInternal === true
  );
}
