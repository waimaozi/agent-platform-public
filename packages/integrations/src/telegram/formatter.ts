export type TelegramTaskStage = "planning" | "researching" | "coding" | "verifying" | "completed";

export interface CostSnapshotLike {
  totalEstimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalWallTimeMs?: number | null;
  modelBreakdownJson?: Record<string, number> | null;
}

export interface TelegramArtifact {
  type: string;
  ref: string;
}

const stageLabels: Record<TelegramTaskStage, string> = {
  planning: "Планирую",
  researching: "Исследую",
  coding: "Кодирую",
  verifying: "Проверяю",
  completed: "Готово"
};

const INTERNAL_JARGON_RE = /\b(supervisor|verifier|subagent|mock)\b/i;
const PRISMA_RE = /prisma|P\d{4}|invalid .* invocation/i;
const STACK_TRACE_RE = /^\s*at\s.+:\d+:\d+/m;

export const TELEGRAM_WELCOME_MESSAGE = [
  "Привет! Я Мира — AI-ассистент.",
  "",
  "Что я умею:",
  "• Отвечать на вопросы и искать информацию",
  "• Работать с проектами и задачами",
  "• Отправлять email",
  "• Работать с n8n воркфлоу",
  "• Запоминать важные факты",
  "",
  "Команды:",
  "/help — список всех команд",
  "/project list — проекты",
  "/report — отчёт за день",
  "/cost — стоимость задач",
  "/pin <факт> — запомнить факт",
  "/email send — отправить письмо",
  "/n8n list — воркфлоу n8n",
  "",
  "Просто напиши мне что нужно — я разберусь."
].join("\n");

export const TELEGRAM_HELP_MESSAGE = [
  "Команды:",
  "/help — список всех команд",
  "/project list — проекты",
  "/report — отчёт за день",
  "/cost — стоимость задач",
  "/pin <факт> — запомнить факт",
  "/email send — отправить письмо",
  "/n8n list — воркфлоу n8n",
  "",
  "Напиши, что нужно сделать."
].join("\n");

export function escapeTelegramMarkdown(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

export function formatTaskCreated(taskId: string, title: string): string {
  void taskId;
  return [
    "*Приняла задачу*",
    escapeTelegramMarkdown(title),
    "",
    "_Начинаю обработку_"
  ].join("\n");
}

export function formatTaskProgress(stage: TelegramTaskStage, taskId: string): string {
  void taskId;
  const stageIcons: Record<TelegramTaskStage, string> = {
    planning: "⏳",
    researching: "🔍",
    coding: "💻",
    verifying: "✅",
    completed: "✅"
  };

  return `${stageIcons[stage]} *${stageLabels[stage]}\\.\\.\\.*`;
}

export function formatCostSummary(snapshot: CostSnapshotLike | null | undefined): string {
  if (!snapshot) {
    return "*Стоимость*: данных пока нет";
  }

  const lines = [
    "*Стоимость*",
    `Оценка: \\$${snapshot.totalEstimatedCostUsd.toFixed(6)}`,
    `Токены: in ${snapshot.totalInputTokens} \\| out ${snapshot.totalOutputTokens}`
  ];

  if (typeof snapshot.totalWallTimeMs === "number") {
    lines.push(`Время: ${Math.round(snapshot.totalWallTimeMs)} мс`);
  }

  const breakdown = snapshot.modelBreakdownJson ?? {};
  for (const [modelKey, cost] of Object.entries(breakdown)) {
    lines.push(`• ${escapeTelegramMarkdown(modelKey)}: \\$${cost.toFixed(6)}`);
  }

  return lines.join("\n");
}

export function formatTaskCompleted(
  summary: string,
  cost: CostSnapshotLike | null | undefined,
  artifacts: TelegramArtifact[]
): string {
  const cleanedSummary = sanitizeUserFacingText(summary) ?? "Готово.";
  const lines = [
    "*Готово*",
    escapeTelegramMarkdown(cleanedSummary),
    "",
    formatCostSummary(cost)
  ];

  if (artifacts.length > 0) {
    lines.push("", "*Артефакты*");
    for (const artifact of artifacts) {
      lines.push(`• ${escapeTelegramMarkdown(`${artifact.type}: ${artifact.ref}`)}`);
    }
  }

  return lines.join("\n");
}

export function formatTaskFailed(reason: string, taskId: string): string {
  void taskId;
  return escapeTelegramMarkdown(getUserSafeErrorMessage(reason));
}

export function sanitizeUserFacingText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/\bfor task [a-z0-9-]+\b/gi, "")
    .replace(/\btask [a-z0-9-]+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || INTERNAL_JARGON_RE.test(normalized) || PRISMA_RE.test(normalized) || STACK_TRACE_RE.test(normalized)) {
    return null;
  }

  return normalized;
}

export function isInternalErrorMessage(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return PRISMA_RE.test(value) || STACK_TRACE_RE.test(value);
}

export function getUserSafeErrorMessage(reason: string | null | undefined): string {
  if (isInternalErrorMessage(reason)) {
    return "Произошла внутренняя ошибка. Попробуй позже.";
  }

  return "Не удалось обработать запрос. Попробуй переформулировать.";
}
