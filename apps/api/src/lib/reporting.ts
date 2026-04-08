import { PrismaClient, TaskState } from "@prisma/client";
import { prisma } from "@agent-platform/core";

export interface ActivityReport {
  completed: number;
  failed: number;
  pending: number;
  totalCostUsd: number;
  topProjects: Array<{ name: string; activityCount: number }>;
  stuckTasks: Array<{ id: string; title: string; ageMinutes: number }>;
  nextDeadlines: Array<{ name: string; deadline: Date }>;
}

export async function buildActivityReport(
  input: { userId?: string; days: number; now?: Date },
  db: PrismaClient = prisma
): Promise<ActivityReport> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.days * 24 * 60 * 60_000);
  const taskWhere = {
    userId: input.userId,
    createdAt: { gte: since }
  };

  const tasks = await db.task.findMany({
    where: taskWhere,
    select: {
      id: true,
      title: true,
      state: true,
      createdAt: true,
      updatedAt: true,
      metadata: true,
      projectProfile: {
        select: { name: true }
      }
    }
  });
  const visibleTasks = tasks.filter((task) => !isSystemInternal(task as Record<string, unknown>));

  const completed = visibleTasks.filter((task) => task.state === "COMPLETED").length;
  const failed = visibleTasks.filter((task) => task.state === "FAILED").length;
  const pending = visibleTasks.filter((task) => !["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)).length;
  const stuckTasks = visibleTasks
    .filter((task) => isPendingState(task.state) && now.getTime() - task.updatedAt.getTime() > 30 * 60_000)
    .map((task) => ({
      id: task.id,
      title: task.title,
      ageMinutes: Math.round((now.getTime() - task.updatedAt.getTime()) / 60_000)
    }))
    .sort((left, right) => right.ageMinutes - left.ageMinutes);

  const costSnapshots = await db.taskCostSnapshot.findMany({
    where: {
      task: {
        userId: input.userId,
        createdAt: { gte: since }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  const latestPerTask = new Map<string, number>();
  for (const snapshot of costSnapshots) {
    if (!latestPerTask.has(snapshot.taskId)) {
      latestPerTask.set(snapshot.taskId, snapshot.totalEstimatedCostUsd);
    }
  }

  const topProjects = Array.from(
    visibleTasks.reduce((map, task) => {
      const name = task.projectProfile?.name;
      if (!name) {
        return map;
      }
      map.set(name, (map.get(name) ?? 0) + 1);
      return map;
    }, new Map<string, number>())
  )
    .map(([name, activityCount]) => ({ name, activityCount }))
    .sort((left, right) => right.activityCount - left.activityCount)
    .slice(0, 3);

  const nextDeadlines = await (db.projectProfile as any).findMany({
    where: {
      deadline: {
        gte: now,
        lte: new Date(now.getTime() + input.days * 24 * 60 * 60_000)
      }
    },
    orderBy: { deadline: "asc" },
    select: {
      name: true,
      deadline: true
    },
    take: 5
  });

  return {
    completed,
    failed,
    pending,
    totalCostUsd: [...latestPerTask.values()].reduce((sum, value) => sum + value, 0),
    topProjects,
    stuckTasks,
    nextDeadlines: nextDeadlines.flatMap((project: any) =>
      project.deadline ? [{ name: project.name, deadline: project.deadline }] : []
    )
  };
}

export function formatActivityReport(report: ActivityReport, label: string): string {
  const lines = [
    `Report (${label})`,
    `Tasks: ${report.completed} completed, ${report.failed} failed, ${report.pending} pending`,
    `Total cost: $${report.totalCostUsd.toFixed(2)}`
  ];

  lines.push(
    report.topProjects.length > 0
      ? `Top projects: ${report.topProjects.map((project) => `${project.name} (${project.activityCount})`).join(", ")}`
      : "Top projects: none"
  );
  lines.push(
    report.stuckTasks.length > 0
      ? `Stuck tasks: ${report.stuckTasks.map((task) => `${task.id} (${task.ageMinutes}m)`).join(", ")}`
      : "Stuck tasks: none"
  );
  lines.push(
    report.nextDeadlines.length > 0
      ? `Next deadlines: ${report.nextDeadlines.map((project) => `${project.name} ${project.deadline.toISOString().slice(0, 10)}`).join(", ")}`
      : "Next deadlines: none"
  );

  return lines.join("\n");
}

function isPendingState(state: TaskState) {
  return !["COMPLETED", "FAILED", "CANCELLED"].includes(state);
}

function isSystemInternal(task: Record<string, unknown>) {
  const metadata = task.metadata;
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).systemInternal === true
  );
}
