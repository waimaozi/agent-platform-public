import { describe, expect, it } from "vitest";
import {
  formatTaskFailed,
  sanitizeUserFacingText
} from "../packages/integrations/src/telegram/formatter.js";
import { buildFinalTelegramMessage } from "../apps/worker/src/final-task-message.js";

describe("telegram user-facing messages", () => {
  it("hides internal jargon in failed task messages", () => {
    expect(formatTaskFailed("PrismaClientKnownRequestError: boom", "task-1")).toBe(
      "Произошла внутренняя ошибка\\. Попробуй позже\\."
    );
    expect(sanitizeUserFacingText("Mock supervisor synthesized 1 subagent result for task abc")).toBeNull();
  });

  it("builds clean final messages", () => {
    expect(
      buildFinalTelegramMessage({
        state: "FAILED",
        taskEvents: [
          {
            type: "task.synthesized",
            payload: { summary: "Готовый ответ" }
          }
        ],
        costSnapshots: []
      })
    ).toBe("Готовый ответ\n\n⚠️ Ответ может быть неполным");

    expect(
      buildFinalTelegramMessage({
        state: "FAILED",
        taskEvents: [
          {
            type: "task.synthesized",
            payload: { summary: "Mock verifier accepted the coder output" }
          }
        ],
        costSnapshots: []
      })
    ).toBe("Не удалось обработать запрос. Попробуй переформулировать.");
  });
});
