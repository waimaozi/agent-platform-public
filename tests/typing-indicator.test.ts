import { beforeEach, describe, expect, it, vi } from "vitest";
import { startTelegramTypingIndicator } from "../apps/worker/src/typing-indicator.js";

describe("startTelegramTypingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sends typing immediately and on interval until stopped", async () => {
    const sendChatAction = vi.fn(async () => undefined);

    const stop = startTelegramTypingIndicator({
      chatId: "chat-1",
      telegramClient: { sendChatAction },
      intervalMs: 4_000
    });

    expect(sendChatAction).toHaveBeenCalledWith("chat-1", "typing");

    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });
});
