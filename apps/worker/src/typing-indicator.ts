import type { TelegramClient } from "@agent-platform/integrations";

export function startTelegramTypingIndicator(input: {
  chatId: string;
  telegramClient: Pick<TelegramClient, "sendChatAction">;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 4_000;

  void input.telegramClient.sendChatAction(input.chatId, "typing");

  const timer = setInterval(() => {
    void input.telegramClient.sendChatAction(input.chatId, "typing");
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
