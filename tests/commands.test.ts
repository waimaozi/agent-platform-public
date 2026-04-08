import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryItems: Array<Record<string, any>> = [];
const projects: Array<Record<string, any>> = [];
const tasks: Array<Record<string, any>> = [];
const taskCostSnapshots: Array<Record<string, any>> = [];

vi.mock("@agent-platform/core", () => ({
  prisma: {
    memoryItem: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => memoryItems.filter((item) => matches(item, where))),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => memoryItems.find((item) => matches(item, where)) ?? null)
    },
    contextBundle: {
      findFirst: vi.fn(async () => null)
    },
    projectProfile: {
      findMany: vi.fn(async () => [...projects]),
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => projects.find((project) => matchesProject(project, where)) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const project = {
          id: `project-${projects.length + 1}`,
          deadline: null,
          lastActivityAt: null,
          blockers: [],
          notes: null,
          priority: "normal",
          status: "planning",
          repoUrl: null,
          ...data
        };
        projects.push(project);
        return project;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const project = projects.find((item) => item.id === where.id);
        if (!project) {
          throw new Error("missing project");
        }
        Object.assign(project, data);
        return project;
      })
    },
    task: {
      findMany: vi.fn(async () => [...tasks])
    },
    taskCostSnapshot: {
      findMany: vi.fn(async () => [...taskCostSnapshots])
    }
  },
  cancelTask: vi.fn(),
  getTaskCostBreakdown: vi.fn(),
  getTaskStatusSnapshot: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn()
}));

vi.mock("@agent-platform/memory-fabric", () => ({
  PrismaMemoryFabric: class PrismaMemoryFabric {
    async pin(userId: string, content: string, scopeId?: string, memoryType = "pinned_fact") {
      const item = {
        id: `memory-${memoryItems.length + 1}`,
        userId,
        scopeType: "pinned",
        scopeId: scopeId ?? null,
        status: "durable",
        memoryType,
        content,
        importance: 1,
        updatedAt: new Date(),
        createdAt: new Date()
      };
      memoryItems.push(item);
      return item;
    }

    async forget(memoryId: string) {
      const item = memoryItems.find((entry) => entry.id === memoryId);
      if (item) {
        item.status = "forgotten";
      }
    }

    async createDurable(input: Record<string, any>) {
      const item = {
        id: `memory-${memoryItems.length + 1}`,
        status: "durable",
        updatedAt: new Date(),
        createdAt: new Date(),
        ...input
      };
      memoryItems.push(item);
      return item;
    }
  }
}));

describe("scoped memory commands", () => {
  beforeEach(() => {
    memoryItems.length = 0;
    projects.length = 0;
    tasks.length = 0;
    taskCostSnapshots.length = 0;
    vi.resetModules();
  });

  it("handles project, trigger, finance, deadline, and report commands", async () => {
    projects.push({
      id: "project-1",
      name: "Agent Platform",
      status: "active",
      priority: "normal",
      deadline: null,
      blockers: [],
      lastActivityAt: null,
      notes: null,
      repoUrl: null
    });
    tasks.push({
      id: "task-1",
      title: "Fix bug",
      state: "RUNNING",
      createdAt: new Date("2026-04-07T00:00:00.000Z"),
      updatedAt: new Date("2026-04-07T00:40:00.000Z"),
      metadata: {},
      projectProfile: { name: "Agent Platform" }
    });
    taskCostSnapshots.push({
      taskId: "task-1",
      totalEstimatedCostUsd: 1.23,
      createdAt: new Date("2026-04-07T00:45:00.000Z")
    });

    const { maybeHandleScopedMemoryCommand } = await import("../apps/api/src/routes/telegram-webhook.js");

    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/project list" })
    ).toContain("Agent Platform [active]");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/project Agent Platform" })
    ).toContain("Active project set");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/project update Agent Platform status=on_hold" })
    ).toContain("Project updated");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/deadline Agent Platform 2026-04-09" })
    ).toContain("2026-04-09");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/log-trigger context switching" })
    ).toContain("Trigger logged");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/triggers" })
    ).toContain("context switching");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/finance Monthly burn is capped" })
    ).toContain("Financial fact saved");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/finance list" })
    ).toContain("Monthly burn is capped");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/report" })
    ).toContain("Total cost: $1.23");
    expect(
      await maybeHandleScopedMemoryCommand({ userId: "user-1", chatId: "chat-1", text: "/report weekly" })
    ).toContain("Report (7d)");
  });

  it("handles email and calendar commands", async () => {
    const emailClient = {
      send: vi.fn(async () => undefined)
    };
    const n8nClient = {
      callWebhook: vi.fn(async () => ({ ok: true }))
    };

    const { maybeHandleScopedMemoryCommand } = await import("../apps/api/src/routes/telegram-webhook.js");

    await expect(
      maybeHandleScopedMemoryCommand({
        userId: "user-1",
        chatId: "chat-1",
        text: "/email send user@example.com Subject | Body text",
        services: { emailClient, n8nClient }
      })
    ).resolves.toBe("Письмо отправлено на user@example.com");
    expect(emailClient.send).toHaveBeenCalledWith({
      to: "user@example.com",
      subject: "Subject",
      body: "Body text"
    });

    await expect(
      maybeHandleScopedMemoryCommand({
        userId: "user-1",
        chatId: "chat-1",
        text: "/email send letters@example.ru Subject | Body text",
        services: { emailClient, n8nClient }
      })
    ).resolves.toContain("ExampleCorp mail agent");
    expect(n8nClient.callWebhook).toHaveBeenCalledWith("imap-agent", {
      to: "letters@example.ru",
      subject: "Subject",
      body: "Body text"
    });

    await expect(
      maybeHandleScopedMemoryCommand({
        userId: "user-1",
        chatId: "chat-1",
        text: "/email read",
        services: { emailClient, n8nClient }
      })
    ).resolves.toContain("Email reading via n8n");
    expect(n8nClient.callWebhook).toHaveBeenCalledWith("agent-email-read", {
      userId: "user-1",
      chatId: "chat-1"
    });

    await expect(
      maybeHandleScopedMemoryCommand({
        userId: "user-1",
        chatId: "chat-1",
        text: "/calendar",
        services: { emailClient, n8nClient }
      })
    ).resolves.toContain("Calendar via n8n");
    expect(n8nClient.callWebhook).toHaveBeenCalledWith("agent-calendar-events", {
      userId: "user-1",
      chatId: "chat-1"
    });
  });

  it("lists registered n8n workflows and calls active ones", async () => {
    const n8nClient = {
      callWebhook: vi.fn(async () => ({ response: "SGR answer" }))
    };

    const { maybeHandleScopedMemoryCommand } = await import("../apps/api/src/routes/telegram-webhook.js");

    await expect(
      maybeHandleScopedMemoryCommand({
        userId: "user-1",
        chatId: "chat-1",
        text: "/n8n list",
        services: {
          emailClient: { send: vi.fn(async () => undefined) },
          n8nClient
        }
      })
    ).resolves.toContain("ExampleCorp SGR Bot [active]");

    await expect(
      maybeHandleScopedMemoryCommand({
        userId: "user-1",
        chatId: "chat-1",
        text: "/n8n call example-sgr {\"query\":\"какие средства для дезинфекции?\"}",
        services: {
          emailClient: { send: vi.fn(async () => undefined) },
          n8nClient
        }
      })
    ).resolves.toBe("SGR answer");

    expect(n8nClient.callWebhook).toHaveBeenCalledWith("example-test", {
      query: "какие средства для дезинфекции?"
    });
  });
});

function matches(item: Record<string, any>, where: Record<string, any> | undefined) {
  if (!where) {
    return true;
  }

  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("startsWith" in value) {
        return String(item[key]).startsWith(String(value.startsWith));
      }
      if ("contains" in value) {
        return String(item[key]).includes(String(value.contains));
      }
    }
    return item[key] === value;
  });
}

function matchesProject(project: Record<string, any>, where: Record<string, any>) {
  const clauses = Array.isArray(where.OR) ? where.OR : [where];
  return clauses.some((clause) =>
    Object.entries(clause).every(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if ("equals" in value) {
          return String(project[key]).toLowerCase() === String(value.equals).toLowerCase();
        }
        if ("contains" in value) {
          return String(project[key]).toLowerCase().includes(String(value.contains).toLowerCase());
        }
      }
      return project[key] === value;
    })
  );
}
