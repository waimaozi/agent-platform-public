import { describe, expect, it } from "vitest";
import { executionPacketSchema, resultPacketSchema } from "@agent-platform/contracts";

describe("execution and result packets", () => {
  it("validates a complete execution_packet", () => {
    const parsed = executionPacketSchema.safeParse({
      taskId: "tsk_123",
      goal: "Implement packet handoff",
      repo: "github.com/org/repo",
      scope: "task",
      problemStatement: "Replace free-form briefs with execution_packet handoff.",
      acceptanceCriteria: ["execution_packet reaches coder runtime"],
      constraints: ["minimal blast radius"],
      allowedPaths: ["packages/**", "tests/**", "docs/**"],
      forbiddenPaths: [".git/**"],
      toolsAllowed: ["read", "edit", "test", "git"],
      approvalRequiredFor: ["new dependency"],
      artifactsRequired: ["summary", "diff", "tests"],
      budget: {
        timeMinutes: 45,
        tokenBudgetClass: "normal"
      },
      doneDefinition: ["typecheck passes", "tests pass"]
    });

    expect(parsed.success).toBe(true);
  });

  it("validates a complete result_packet", () => {
    const parsed = resultPacketSchema.safeParse({
      taskId: "tsk_123",
      status: "completed",
      summary: "Implemented packet handoff.",
      filesChanged: ["packages/supervisor/src/index.ts"],
      artifacts: ["diff", "tests"],
      testsRun: ["npx vitest run"],
      risks: [],
      followups: ["Extract packet builder into shared helper."],
      scriptizationCandidates: ["Persist packet defaults in code."],
      blockers: []
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects malformed packet payloads", () => {
    const execution = executionPacketSchema.safeParse({
      taskId: "tsk_123",
      goal: "Broken packet",
      scope: "task",
      problemStatement: "Missing lists and budget"
    });
    const result = resultPacketSchema.safeParse({
      taskId: "tsk_123",
      status: "completed",
      summary: "Missing required arrays"
    });

    expect(execution.success).toBe(false);
    expect(result.success).toBe(false);
  });
});
