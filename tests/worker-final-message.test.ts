import { describe, expect, it } from "vitest";
import { buildFinalTelegramMessage } from "../apps/worker/src/final-task-message.js";

describe("worker final telegram delivery", () => {
  it("uses task.synthesized summary for completed tasks", () => {
    const text = buildFinalTelegramMessage({
      state: "COMPLETED",
      costSnapshots: [{ totalEstimatedCostUsd: 1.237 }],
      taskEvents: [
        { type: "task.completed", payload: { summary: "Старый summary" } },
        { type: "task.synthesized", payload: { summary: "Итоговый ответ пользователю." } }
      ]
    });

    expect(text).toBe("Итоговый ответ пользователю\\.");
  });

  it("returns a generic failure message when no answer is available", () => {
    const text = buildFinalTelegramMessage({
      state: "FAILED",
      costSnapshots: [{ totalEstimatedCostUsd: 0.126 }],
      taskEvents: [{ type: "task.failed", payload: { reason: "Не удалось получить данные." } }]
    });

    expect(text).toBe("Не удалось обработать запрос. Попробуй переформулировать.");
  });

  it("delivers synthesized summary as a partial result for failed tasks", () => {
    const text = buildFinalTelegramMessage({
      state: "FAILED",
      costSnapshots: [{ totalEstimatedCostUsd: 0.126 }],
      taskEvents: [
        { type: "task.synthesized", payload: { summary: "Полезный итоговый ответ." } },
        { type: "task.failed", payload: { reason: "Верификатор запросил доработку." } }
      ]
    });

    expect(text).toBe(
      [
        "Полезный итоговый ответ\\.",
        "",
        "⚠️ Ответ может быть неполным"
      ].join("\n")
    );
    expect(text).not.toContain("Что\\-то пошло не так");
    expect(text).not.toContain("*Не удалось выполнить задачу*");
  });
});
