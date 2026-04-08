import { appendTaskEvent, prisma, transitionTaskState } from "@agent-platform/core";

const STUCK_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const STUCK_TASK_STATES = ["PLANNING", "RUNNING"] as const;

export interface CleanupLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface CleanupStuckTasksDependencies {
  now?: Date;
  logger: CleanupLogger;
}

export async function cleanupStuckTasksOnStartup(
  dependencies: CleanupStuckTasksDependencies
): Promise<{ scanned: number; failed: number }> {
  const now = dependencies.now ?? new Date();
  const cutoff = new Date(now.getTime() - STUCK_TASK_TIMEOUT_MS);
  const stuckTasks = await prisma.task.findMany({
    where: {
      state: { in: [...STUCK_TASK_STATES] },
      updatedAt: { lt: cutoff }
    },
    select: {
      id: true,
      state: true,
      updatedAt: true
    }
  });

  let failed = 0;

  for (const task of stuckTasks) {
    try {
      await transitionTaskState(task.id, "FAILED");
      await appendTaskEvent({
        taskId: task.id,
        type: "task.failed",
        actor: "supervisor",
        payload: { reason: "Task timed out during processing" }
      });
      failed += 1;
    } catch (error) {
      dependencies.logger.warn(
        {
          taskId: task.id,
          state: task.state,
          updatedAt: task.updatedAt.toISOString(),
          err: error
        },
        "Skipping stuck task cleanup because the task state changed"
      );
    }
  }

  dependencies.logger.info(
    {
      scanned: stuckTasks.length,
      failed
    },
    "Completed stuck task cleanup on worker startup"
  );

  return {
    scanned: stuckTasks.length,
    failed
  };
}
