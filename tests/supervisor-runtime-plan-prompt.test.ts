import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeSupervisorRuntime } from "../packages/supervisor-runtime/src/index.js";
import type { Task } from "@agent-platform/contracts";

describe("ClaudeCodeSupervisorRuntime plan prompt", () => {
  it("includes strict answer_self-first routing guidance", async () => {
    const runtime = new ClaudeCodeSupervisorRuntime();
    let capturedPrompt = "";

    vi.spyOn(ClaudeCodeSupervisorRuntime.prototype as any, "callClaude").mockImplementation(
      async (...args: unknown[]) => {
        const [prompt] = args as [string];
        capturedPrompt = prompt;
        return {
          result: JSON.stringify({
            plan: {
              steps: [],
              estimatedCost: 0,
              routingProfile: "balanced",
              approvalRequired: false
            },
            routeDecision: {
              goal: "Answer directly",
              scope: "task",
              executionType: "answer_self",
              capabilityId: null,
              whyThisPath: "No code changes required.",
              whyNotCheaperPath: "This is already the cheapest path.",
              risk: "low",
              budgetClass: "normal",
              expectedArtifacts: ["answer"],
              fallback: "Escalate if code changes appear."
            },
            directAnswer: "answer",
            estimatedCost: 0
          })
        };
      }
    );

    const task: Task = {
      id: "task-1",
      userId: "user-1",
      channel: "telegram",
      threadId: "chat-1",
      title: "Объясни что такое X",
      rawInput: "Объясни что такое X",
      normalizedInput: "Объясни что такое X",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-1",
      createdAt: "2026-04-07T00:00:00.000Z",
      updatedAt: "2026-04-07T00:00:00.000Z"
    };

    await runtime.plan(task, {});

    expect(capturedPrompt).toContain("ROUTING RULES (STRICT):");
    expect(capturedPrompt).toContain("ANY question that can be answered from context, files, or knowledge");
    expect(capturedPrompt).toContain("\"Read file X\", \"what's in X\", \"summarize X\", \"analyze X\"");
    expect(capturedPrompt).toContain("codex — USE THIS ONLY for:");
    expect(capturedPrompt).toContain("Tasks where the deliverable is a CODE CHANGE (diff, new file, PR)");
    expect(capturedPrompt).toContain("workflow — USE THIS for:");
    expect(capturedPrompt).toContain("Sending email via SMTP");
    expect(capturedPrompt).toContain("DEFAULT: If unsure, use answer_self. It's always safer and cheaper.");
  });
});
