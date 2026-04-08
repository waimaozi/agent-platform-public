import { escapeTelegramMarkdown, sanitizeUserFacingText } from "@agent-platform/integrations";

interface TaskEventLike {
  type: string;
  payload: unknown;
}

interface CostSnapshotLike {
  totalEstimatedCostUsd: number;
}

interface TaskDetailLike {
  state: string;
  taskEvents: TaskEventLike[];
  costSnapshots: CostSnapshotLike[];
}

export function buildFinalTelegramMessage(task: TaskDetailLike): string | null {
  void task.costSnapshots;
  const summary = sanitizeUserFacingText(getSynthesisSummary(task.taskEvents));

  if (task.state === "COMPLETED") {
    return escapeTelegramMarkdown(summary ?? "Готово.");
  }

  if (task.state === "FAILED") {
    if (summary) {
      return [
        escapeTelegramMarkdown(summary),
        "",
        escapeTelegramMarkdown("⚠️ Ответ может быть неполным")
      ].join("\n");
    }

    return "Не удалось обработать запрос. Попробуй переформулировать.";
  }

  return null;
}

function getSynthesisSummary(events: TaskEventLike[]): string | null {
  const summaryEvent = [...events].reverse().find((event) => event.type === "task.synthesized");
  return getString(asObject(summaryEvent?.payload).summary);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
