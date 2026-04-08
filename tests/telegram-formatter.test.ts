import { describe, expect, it } from "vitest";
import { formatTaskProgress } from "../packages/integrations/src/telegram/formatter.js";

describe("telegram formatter", () => {
  it("omits task ids from progress messages", () => {
    expect(formatTaskProgress("planning", "task-123")).toBe("⏳ *Планирую\\.\\.\\.*");
    expect(formatTaskProgress("researching", "task-123")).toBe("🔍 *Исследую\\.\\.\\.*");
    expect(formatTaskProgress("coding", "task-123")).toBe("💻 *Кодирую\\.\\.\\.*");
    expect(formatTaskProgress("verifying", "task-123")).toBe("✅ *Проверяю\\.\\.\\.*");
  });
});
