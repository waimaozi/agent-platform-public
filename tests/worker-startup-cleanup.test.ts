import { beforeEach, describe, expect, it, vi } from "vitest";

describe("worker startup stuck task cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fails stale planning and running tasks older than 10 minutes", async () => {
    const transitions: Array<{ taskId: string; nextState: string }> = [];
    const failureEvents: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findMany: vi.fn(async () => [
            {
              id: "task-planning",
              state: "PLANNING",
              updatedAt: new Date("2026-04-07T09:45:00.000Z")
            },
            {
              id: "task-running",
              state: "RUNNING",
              updatedAt: new Date("2026-04-07T09:40:00.000Z")
            }
          ])
        }
      },
      transitionTaskState: vi.fn(async (taskId: string, nextState: string) => {
        transitions.push({ taskId, nextState });
        return null;
      }),
      appendTaskEvent: vi.fn(async ({ taskId, type, payload }: { taskId: string; type: string; payload: Record<string, unknown> }) => {
        failureEvents.push({ taskId, type, payload });
        return null;
      })
    }));

    const { cleanupStuckTasksOnStartup } = await import("../apps/worker/src/stuck-task-cleanup.js");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const result = await cleanupStuckTasksOnStartup({
      now: new Date("2026-04-07T10:00:00.000Z"),
      logger
    });

    expect(result).toEqual({ scanned: 2, failed: 2 });
    expect(transitions).toEqual([
      { taskId: "task-planning", nextState: "FAILED" },
      { taskId: "task-running", nextState: "FAILED" }
    ]);
    expect(failureEvents).toEqual([
      {
        taskId: "task-planning",
        type: "task.failed",
        payload: { reason: "Task timed out during processing" }
      },
      {
        taskId: "task-running",
        type: "task.failed",
        payload: { reason: "Task timed out during processing" }
      }
    ]);
  });
});
