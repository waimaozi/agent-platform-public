import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpN8nClient } from "@agent-platform/integrations";

describe("HttpN8nClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes the expected webhook fetch call", async () => {
    const jsonMock = vi.fn(async () => ({ ok: true }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: vi.fn(() => "application/json")
      },
      json: jsonMock
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpN8nClient("https://n8n.example.com", "api-key");
    const result = await client.callWebhook("mira-calendar-events", { limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith("https://n8n.example.com/webhook/mira-calendar-events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": "api-key"
      },
      body: JSON.stringify({ limit: 10 })
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns text responses when the webhook is not json", async () => {
    const textMock = vi.fn(async () => "plain text response");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: vi.fn(() => "text/plain")
      },
      text: textMock
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpN8nClient("https://n8n.example.com");
    const result = await client.callWebhook("imap-agent", { ok: true });

    expect(result).toBe("plain text response");
  });
});
