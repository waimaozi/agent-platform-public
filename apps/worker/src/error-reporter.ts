import { TelegramClient } from "@agent-platform/integrations";

export async function reportTaskError(taskId: string, error: string, chatId: string): Promise<void> {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID ?? process.env.TELEGRAM_BOOTSTRAP_CHAT_ID;
  if (!adminChatId) {
    return;
  }

  const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? "");
  const message = [
    "⚠️ Ошибка в задаче:",
    `Task: ${taskId}`,
    `Source chat: ${chatId}`,
    `> ${error.slice(0, 200)}`,
    "",
    "Я попробую разобраться автоматически."
  ].join("\n");

  await client.sendMessage({ chatId: adminChatId, text: message });
}
