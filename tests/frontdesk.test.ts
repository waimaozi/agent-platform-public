import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordMock = vi.fn(async (_input: unknown) => ({ estimatedCostUsd: 0 }));

vi.mock("@agent-platform/model-gateway", () => ({
  StaticPricingCatalog: class StaticPricingCatalog {},
  PrismaLlmCallLogger: class PrismaLlmCallLogger {
    async record(input: unknown) {
      return recordMock(input);
    }
  }
}));

describe("MockFrontdesk", () => {
  beforeEach(() => {
    recordMock.mockClear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies greetings as banter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { MockFrontdesk } = await import("@agent-platform/frontdesk");
    const frontdesk = new MockFrontdesk();
    const result = await frontdesk.classify({ messageText: "Привет" });

    expect(result.classification).toBe("banter");
    expect(result.replyMode).toBe("frontdesk_auto");
    expect(result.autoReply).toBe("Привет! Чем могу помочь?");
  });

  it("classifies code questions as task_request", async () => {
    const { MockFrontdesk } = await import("@agent-platform/frontdesk");
    const frontdesk = new MockFrontdesk();
    const result = await frontdesk.classify({
      messageText: "Can you fix a bug in apps/api/src/routes/telegram-webhook.ts?"
    });

    expect(result.classification).toBe("task_request");
    expect(result.replyMode).toBe("escalate_with_context");
    expect(result.taskBrief).toContain("telegram-webhook.ts");
  });

  it("classifies file reads as task_request", async () => {
    const { MockFrontdesk } = await import("@agent-platform/frontdesk");
    const frontdesk = new MockFrontdesk();
    const result = await frontdesk.classify({
      messageText: "Прочитай docs/economics.md и покажи, что там"
    });

    expect(result.classification).toBe("task_request");
    expect(result.replyMode).toBe("escalate_with_context");
    expect(result.taskBrief).toContain("docs/economics.md");
  });

  it("classifies summaries as question", async () => {
    const { MockFrontdesk } = await import("@agent-platform/frontdesk");
    const frontdesk = new MockFrontdesk();
    const result = await frontdesk.classify({
      messageText: "Summary docs/economics.md"
    });

    expect(result.classification).toBe("question");
    expect(result.replyMode).toBe("escalate_supervisor");
    expect(result.taskBrief).toContain("docs/economics.md");
  });

  it("classifies slash commands as command", async () => {
    const { MockFrontdesk } = await import("@agent-platform/frontdesk");
    const frontdesk = new MockFrontdesk();
    const result = await frontdesk.classify({ messageText: "/status task-123" });

    expect(result.classification).toBe("command");
    expect(result.replyMode).toBe("silent");
  });

  it("uses OpenRouter response for NanoFrontdesk and logs the call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  classification: "task_request",
                  replyMode: "escalate_supervisor",
                  scope: "task",
                  entities: { repo: "openclaw/agent-platform" },
                  taskBrief: "Fix webhook task routing",
                  autoReply: null
                })
              }
            }
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 11
          }
        })
      }))
    );

    const { NanoFrontdesk } = await import("@agent-platform/frontdesk");
    const frontdesk = new NanoFrontdesk({ apiKey: "test-key" });
    const result = await frontdesk.classify({
      messageText: "Fix the Telegram webhook task routing bug"
    });

    expect(result.classification).toBe("task_request");
    expect(result.replyMode).toBe("escalate_supervisor");
    expect(result.taskBrief).toBe("Fix webhook task routing");
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "system",
        subagentId: "frontdesk",
        provider: "openrouter",
        model: "qwen/qwen3.6-plus:free",
        purpose: "frontdesk_classification",
        promptTokens: 42,
        completionTokens: 11,
        estimatedCostUsd: 0
      })
    );
  });
});
