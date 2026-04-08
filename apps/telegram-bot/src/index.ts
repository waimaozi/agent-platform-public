import { TelegramClient } from "@agent-platform/integrations";

async function main() {
  const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? "");
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

  if (!webhookUrl || !process.env.TELEGRAM_BOT_TOKEN) {
    console.log("Telegram bot bootstrap skipped: TELEGRAM_WEBHOOK_URL or TELEGRAM_BOT_TOKEN is missing.");
    return;
  }

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      url: webhookUrl
    })
  });

  await client.sendMessage({
    chatId: process.env.TELEGRAM_BOOTSTRAP_CHAT_ID ?? "",
    text: "Webhook configured."
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
