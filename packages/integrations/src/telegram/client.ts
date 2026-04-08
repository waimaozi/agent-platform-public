export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramMessageRequest {
  chatId: string;
  text: string;
  parseMode?: "MarkdownV2";
  replyMarkup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly apiBaseUrl = "https://api.telegram.org"
  ) {}

  async sendMessage(request: TelegramMessageRequest): Promise<void> {
    if (!this.token) {
      return;
    }

    await fetch(`${this.apiBaseUrl}/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: request.chatId,
        text: request.text,
        parse_mode: request.parseMode,
        reply_markup: request.replyMarkup
      })
    });
  }

  async sendChatAction(chatId: string, action: string = "typing"): Promise<void> {
    if (!this.token) {
      return;
    }

    await fetch(`${this.apiBaseUrl}/bot${this.token}/sendChatAction`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        action
      })
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.token) {
      return;
    }

    await fetch(`${this.apiBaseUrl}/bot${this.token}/answerCallbackQuery`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text
      })
    });
  }
}
