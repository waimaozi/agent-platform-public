export interface N8nClient {
  callWebhook(path: string, data?: Record<string, unknown>): Promise<unknown>;
}

export class HttpN8nClient implements N8nClient {
  constructor(
    private readonly baseUrl: string = process.env.N8N_BASE_URL ?? "https://n8n2.waimaozi.com",
    private readonly apiKey?: string
  ) {}

  async callWebhook(path: string, data?: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/webhook/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "X-N8N-API-KEY": this.apiKey } : {})
      },
      body: JSON.stringify(data ?? {})
    });

    if (!response.ok) {
      throw new Error(`n8n webhook ${path} failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    const text = await response.text();
    if (!text) {
      return { ok: true };
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
