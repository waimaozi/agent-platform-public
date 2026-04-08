import { PrismaMemoryFabric } from "@agent-platform/memory-fabric";

export interface TaskSummaryRecord {
  taskId: string;
  summary: string;
  accepted: boolean;
}

export class MemoryService extends PrismaMemoryFabric {
  async rememberTaskSummary(record: TaskSummaryRecord): Promise<TaskSummaryRecord> {
    await this.createCandidate({
      scopeType: "task",
      scopeId: record.taskId,
      taskId: record.taskId,
      memoryType: "task_summary",
      content: record.summary,
      confidence: record.accepted ? 0.9 : 0.6,
      importance: record.accepted ? 0.8 : 0.5
    });

    return record;
  }
}

export { PrismaMemoryFabric };
