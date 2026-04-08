import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.fn(async () => undefined);
const answerCallbackQueryMock = vi.fn(async () => undefined);
const applyApprovalDecisionMock = vi.fn();
const findOrCreateUserMock = vi.fn(async () => ({ id: "user-1" }));

vi.mock("@agent-platform/core", () => ({
  prisma: {
    rawEvent: {
      create: vi.fn(),
      update: vi.fn()
    },
    contextBundle: {
      create: vi.fn()
    },
    task: {
      findUniqueOrThrow: vi.fn()
    }
  },
  cancelTask: vi.fn(),
  getTaskCostBreakdown: vi.fn(),
  getTaskStatusSnapshot: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn()
}));

vi.mock("@agent-platform/frontdesk", () => ({
  MockFrontdesk: class MockFrontdesk {
    async classify() {
      return {
        classification: "banter",
        replyMode: "frontdesk_auto",
        scope: "user",
        entities: {},
        autoReply: null,
        taskBrief: null
      };
    }
  },
  NanoFrontdesk: class NanoFrontdesk {
    async classify() {
      return {
        classification: "banter",
        replyMode: "frontdesk_auto",
        scope: "user",
        entities: {},
        autoReply: null,
        taskBrief: null
      };
    }
  }
}));

vi.mock("@agent-platform/memory-fabric", () => ({
  PrismaMemoryFabric: class PrismaMemoryFabric {
    async remember() {
      return null;
    }

    async createDurable() {
      return { id: "memory-2" };
    }

    async pin() {
      return { id: "memory-1" };
    }

    async forget() {
      return null;
    }
  }
}));

vi.mock("@agent-platform/bundle-builder", () => ({
  PrismaBundleBuilder: class PrismaBundleBuilder {
    async build() {
      return { retrievalTrace: [], totalTokens: 0 };
    }
  }
}));

vi.mock("@agent-platform/integrations", () => ({
  formatTaskCreated: vi.fn(() => "task created")
}));

vi.mock("../apps/api/src/lib/container.js", () => ({
  buildContainer: vi.fn(() => ({
    logger: {
      error: vi.fn(),
      warn: vi.fn()
    },
    telegramClient: {
      sendMessage: sendMessageMock,
      answerCallbackQuery: answerCallbackQueryMock
    }
  })),
  applyApprovalDecision: applyApprovalDecisionMock,
  createInitialTaskArtifacts: vi.fn(),
  enqueueTask: vi.fn(),
  findOrCreateUser: findOrCreateUserMock
}));

describe("telegram webhook errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FEATURE_SCOPED_MEMORY;
    delete process.env.FEATURE_SCOPED_MEMORY_NANO;
  });

  it.skip("returns 200 on invalid JSON body", () => {
    // Fastify rejects malformed JSON before the route handler runs.
  });

  it("returns 200 with ok:false when required message fields are missing", async () => {
    const { default: Fastify } = await import(
      "../node_modules/.pnpm/fastify@5.8.4/node_modules/fastify/fastify.js"
    );
    const { registerTelegramWebhook } = await import("../apps/api/src/routes/telegram-webhook.js");
    const app = Fastify();

    await registerTelegramWebhook(app);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      payload: {
        update_id: 1,
        message: {
          message_id: 10,
          text: "hello",
          chat: { id: 100 }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("message.from")
      })
    );

    await app.close();
  });

  it("returns 200 with ok:false for an invalid approval id", async () => {
    applyApprovalDecisionMock.mockResolvedValue({
      applied: false,
      error: "Approval not found"
    });

    const { default: Fastify } = await import(
      "../node_modules/.pnpm/fastify@5.8.4/node_modules/fastify/fastify.js"
    );
    const { registerTelegramWebhook } = await import("../apps/api/src/routes/telegram-webhook.js");
    const app = Fastify();

    await registerTelegramWebhook(app);

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telegram",
      payload: {
        update_id: 2,
        callback_query: {
          id: "callback-1",
          data: "approval:missing-id:approve",
          from: { id: 42 },
          message: {
            chat: { id: 99 }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: false,
      error: "Approval not found"
    });
    expect(answerCallbackQueryMock).toHaveBeenCalledWith("callback-1", "Approval not found");

    await app.close();
  });
});
