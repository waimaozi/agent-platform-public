import { FastifyInstance } from "fastify";
import { getTaskDetail } from "@agent-platform/core";

export async function registerStatusRoutes(app: FastifyInstance) {
  app.get("/tasks/:taskId/status", async (request, reply) => {
    const params = request.params as { taskId: string };
    const task = await getTaskDetail(params.taskId);

    if (!task) {
      return reply.code(404).send({ error: "Task not found" });
    }

    return {
      id: task.id,
      state: task.state,
      title: task.title,
      approvals: task.approvals,
      costSnapshots: task.costSnapshots,
      events: task.taskEvents
    };
  });
}
