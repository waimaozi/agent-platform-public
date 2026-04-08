import { describe, expect, it } from "vitest";

describe("telegram webhook", () => {
  it("returns the welcome message for /start", async () => {
    const { getPresetTelegramCommandMessage } = await import("../apps/api/src/routes/telegram-webhook.js");
    const message = getPresetTelegramCommandMessage("/start");

    expect(message).toContain("Привет! Я Ассистент");
    expect(message).toContain("/help — список всех команд");
  });
});
