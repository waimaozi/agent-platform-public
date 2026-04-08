import { describe, expect, it } from "vitest";
import {
  composeCheckinMessage,
  composeFailurePatternMessage,
  detectFailurePatternAlert,
  evaluateCheckinHeuristics
} from "../apps/worker/src/checkin-job.js";

describe("checkin heuristics", () => {
  it("pings on stuck tasks, inactivity, and upcoming deadlines", () => {
    const now = new Date("2026-04-07T12:00:00.000Z");
    const result = evaluateCheckinHeuristics({
      now,
      tasks: [
        {
          id: "task-1",
          title: "Fix webhook",
          state: "RUNNING",
          createdAt: new Date("2026-04-07T08:00:00.000Z"),
          updatedAt: new Date("2026-04-07T10:00:00.000Z")
        },
        {
          id: "task-2",
          title: "Write docs",
          state: "COMPLETED",
          createdAt: new Date("2026-04-07T01:00:00.000Z"),
          updatedAt: new Date("2026-04-07T03:00:00.000Z")
        }
      ],
      deadlines: [{ name: "Agent Platform", deadline: new Date("2026-04-09T00:00:00.000Z") }],
      pinnedMemory: ["pinned_fact: remember context"],
      projectsMarkdown: "# projects"
    });

    expect(result.shouldPing).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["1 stuck task", "1 deadline within 3 days"])
    );
    expect(composeCheckinMessage(result)).toContain("Mira check-in");
  });

  it("stays silent when recent work is healthy", () => {
    const now = new Date("2026-04-07T12:00:00.000Z");
    const result = evaluateCheckinHeuristics({
      now,
      tasks: [
        {
          id: "task-1",
          title: "Healthy task",
          state: "RUNNING",
          createdAt: new Date("2026-04-07T11:00:00.000Z"),
          updatedAt: new Date("2026-04-07T11:45:00.000Z")
        }
      ],
      deadlines: [],
      pinnedMemory: [],
      projectsMarkdown: "# projects"
    });

    expect(result.shouldPing).toBe(false);
  });

  it("detects clustered failures with the same error pattern", () => {
    const alert = detectFailurePatternAlert([
      { taskId: "task-1", error: "Database does not exist for app" },
      { taskId: "task-2", error: "database does not exist" },
      { taskId: "task-3", error: "Database does not exist in CI" },
      { taskId: "task-4", error: "Database does not exist after reset" },
      { taskId: "task-5", error: "some unrelated issue" }
    ]);

    expect(alert).toEqual({
      pattern: "Database does not exist",
      count: 4,
      hypothesis: "База данных не создана или была пересоздана без нужного database/schema.",
      suggestedFix: "Пересоздать database/schema и проверить DATABASE_URL."
    });
    expect(composeFailurePatternMessage(alert!)).toContain("За последний час 4 задач упало");
    expect(composeFailurePatternMessage(alert!)).toContain("Database does not exist");
  });
});
