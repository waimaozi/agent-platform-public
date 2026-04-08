import { beforeEach, describe, expect, it, vi } from "vitest";

describe("task lifecycle integration scaffolding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates a task, transitions through states, and records lifecycle events", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const task = {
      id: "task-1",
      userId: "user-1",
      channel: "telegram",
      threadId: "chat-1",
      title: "Test task",
      rawInput: "Test task",
      normalizedInput: "Test task",
      state: "NEW",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-1",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      approvals: [],
      costSnapshots: [],
      taskEvents: [],
      budgetPolicy: null,
      user: null,
      llmCallLogs: []
    };

    const fakePrisma = {
      task: {
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          const createdEvents = data.taskEvents.create as Array<{ type: string; payload: Record<string, unknown> }>;
          events.push(...createdEvents);
          task.title = data.title;
          task.rawInput = data.rawInput;
          task.normalizedInput = data.normalizedInput;
          return task;
        }),
        findUniqueOrThrow: vi.fn(async () => task),
        findUnique: vi.fn(async () => task),
        update: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          task.state = data.state ?? task.state;
          const created = data.taskEvents?.create;
          if (created) {
            events.push(...(Array.isArray(created) ? created : [created]));
          }
          return task;
        })
      },
      taskEvent: {
        create: vi.fn(async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
          events.push(data);
          return { id: `${events.length}`, ...data };
        })
      }
    };

    vi.doMock("../../packages/core/src/db/client.js", () => ({
      prisma: fakePrisma
    }));

    const repository = await import("../../packages/core/src/task/task-repository.js");

    await repository.createTaskWithInitialEvent({
      userId: "user-1",
      channel: "telegram",
      threadId: "chat-1",
      title: "Test task",
      rawInput: "Test task",
      normalizedInput: "Test task",
      budgetPolicyId: "budget-1"
    });
    await repository.transitionTaskState(task.id, "INTAKE_NORMALIZED");
    await repository.transitionTaskState(task.id, "PLANNING");
    await repository.transitionTaskState(task.id, "RUNNING");
    await repository.pauseTask(task.id);
    await repository.resumeTask(task.id);
    await repository.cancelTask(task.id);

    expect(task.state).toBe("CANCELLED");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "task.normalized",
        "task.state_changed",
        "task.paused",
        "task.resumed",
        "task.cancelled"
      ])
    );
  });
});
