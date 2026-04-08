import { Prisma, Task as PrismaTask, TaskEvent } from "@prisma/client";
import { EventEnvelope, TaskState } from "@agent-platform/contracts";
import { prisma } from "../db/client.js";
import { assertTransition } from "../state-machine/task-state-machine.js";

export async function createTaskWithInitialEvent(input: {
  userId: string;
  channel: "telegram" | "slack" | "admin";
  threadId: string;
  title: string;
  rawInput: string;
  normalizedInput: string;
  budgetPolicyId: string;
  projectProfileId?: string | null;
  metadata?: Prisma.JsonObject;
}): Promise<PrismaTask> {
  return prisma.task.create({
    data: {
      userId: input.userId,
      channel: input.channel,
      threadId: input.threadId,
      title: input.title,
      rawInput: input.rawInput,
      normalizedInput: input.normalizedInput,
      budgetPolicyId: input.budgetPolicyId,
      projectProfileId: input.projectProfileId,
      metadata: input.metadata ?? {},
      taskEvents: {
        create: [
          {
            type: "task.created",
            actor: "user",
            payload: { title: input.title, rawInput: input.rawInput }
          },
          {
            type: "task.normalized",
            actor: "system",
            payload: { normalizedInput: input.normalizedInput }
          }
        ]
      }
    }
  });
}

export async function appendTaskEvent(input: {
  taskId: string;
  type: string;
  actor: EventEnvelope["actor"];
  payload: Prisma.InputJsonValue;
}): Promise<TaskEvent> {
  return prisma.taskEvent.create({
    data: input
  });
}

export async function transitionTaskState(taskId: string, nextState: TaskState): Promise<PrismaTask> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  assertTransition(task.state as TaskState, nextState);

  return prisma.task.update({
    where: { id: taskId },
    data: {
      state: nextState,
      taskEvents: {
        create: {
          type: "task.state_changed",
          actor: "system",
          payload: {
            from: task.state,
            to: nextState
          }
        }
      }
    }
  });
}

export async function getTaskDetail(taskId: string) {
  return prisma.task.findUnique({
    where: { id: taskId },
    include: {
      approvals: true,
      costSnapshots: true,
      taskEvents: {
        orderBy: {
          createdAt: "asc"
        }
      },
      budgetPolicy: true,
      user: true
    }
  });
}

export async function getTaskStatusSnapshot(taskId: string) {
  return prisma.task.findUnique({
    where: { id: taskId },
    include: {
      costSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });
}

export async function getTaskCostBreakdown(taskId: string) {
  return prisma.task.findUnique({
    where: { id: taskId },
    include: {
      costSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 1
      },
      llmCallLogs: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
}

export async function pauseTask(taskId: string, reason = "Paused by user") {
  await transitionTaskState(taskId, "PAUSED");
  await appendTaskEvent({
    taskId,
    type: "task.paused",
    actor: "user",
    payload: { reason }
  });

  return getTaskStatusSnapshot(taskId);
}

export async function resumeTask(taskId: string, reason = "Resumed by user") {
  await transitionTaskState(taskId, "RUNNING");
  await appendTaskEvent({
    taskId,
    type: "task.resumed",
    actor: "user",
    payload: { reason }
  });

  return getTaskStatusSnapshot(taskId);
}

export async function cancelTask(taskId: string, reason = "Cancelled by user") {
  await transitionTaskState(taskId, "CANCELLED");
  await appendTaskEvent({
    taskId,
    type: "task.cancelled",
    actor: "user",
    payload: { reason }
  });

  return getTaskStatusSnapshot(taskId);
}
