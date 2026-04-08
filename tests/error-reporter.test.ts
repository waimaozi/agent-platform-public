import { afterEach, describe, expect, it, vi } from "vitest";
import { reportTaskError } from "../apps/worker/src/error-reporter.js";

describe("reportTaskError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends a direct telegram message to the admin chat", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token");
    vi.stubEnv("TELEGRAM_ADMIN_CHAT_ID", "admin-chat");

    await reportTaskError("task-1", "Database does not exist for tenant app", "user-chat");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, request] = firstCall as unknown as [string, { body: string; method: string }];
    const body = JSON.parse(request.body) as { chat_id: string; text: string };
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(request).toMatchObject({ method: "POST" });
    expect(body).toMatchObject({
      chat_id: "admin-chat"
    });
    expect(body.text).toContain("⚠️ Ошибка в задаче:");
    expect(body.text).toContain("task-1");
    expect(body.text).toContain("Database does not exist");
  });
});
