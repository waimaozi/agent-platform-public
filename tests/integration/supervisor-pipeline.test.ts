import { mkdir, rm, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockCodexRuntime } from "@agent-platform/codex-runtime";
import { MockSupervisorRuntime } from "@agent-platform/supervisor-runtime";

type MockTaskEvent = { type: string; payload: Record<string, unknown> };

function buildRouteDecision(goal: string) {
  return {
    goal,
    scope: "task" as const,
    executionType: "codex" as const,
    capabilityId: null,
    whyThisPath: "Code changes are required.",
    whyNotCheaperPath: "No cheaper deterministic path exists.",
    risk: "medium" as const,
    budgetClass: "normal" as const,
    expectedArtifacts: ["summary", "diff", "tests"],
    fallback: "Escalate for review if coding blocks."
  };
}

describe("supervisor pipeline integration scaffolding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("runs the supervisor pipeline with pluggable mock runtimes", async () => {
    const transitions: string[] = [];
    const events: string[] = [];
    const statuses: string[] = [];
    const taskRecord = {
      id: "task-42",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Implement change",
      rawInput: "Implement change",
      normalizedInput: "Implement change",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async ({ type }: { type: string }) => {
        events.push(type);
        return null;
      }),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        transitions.push(nextState);
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/supervisor-runtime", () => ({
      MockSupervisorRuntime
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime: new MockSupervisorRuntime(),
      coderRuntime: new MockCodexRuntime(),
      onStatusUpdate: async (stage) => {
        statuses.push(stage);
      }
    });

    expect(transitions).toEqual(["PLANNING", "RUNNING", "VERIFYING", "COMPLETED"]);
    expect(statuses).toEqual(["planning", "researching", "coding", "verifying", "completed"]);
    expect(events).toEqual(
      expect.arrayContaining([
        "task.planned",
        "subagent.dispatched",
        "subagent.completed",
        "coder.result_packet",
        "verifier.completed",
        "task.synthesized",
        "task.completed",
        "improvement.note"
      ])
    );
  });

  it("constructs an execution_packet for the coder", async () => {
    const taskRecord = {
      id: "task-packet",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Implement packet handoff",
      rawInput: "Implement packet handoff",
      normalizedInput: "Implement packet handoff",
      state: "INTAKE_NORMALIZED",
      repoRefs: ["github.com/org/repo"],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };
    let startRunInput: Record<string, unknown> | undefined;

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async () => null),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const coderRuntime = {
      startRun: vi.fn(async (input) => {
        startRunInput = input as Record<string, unknown>;
        return { runId: "codex_task-packet" };
      }),
      async *streamEvents() {
        yield {
          type: "codex.run.started",
          createdAt: new Date().toISOString(),
          payload: { runId: "codex_task-packet" }
        };
        yield {
          type: "codex.run.completed",
          createdAt: new Date().toISOString(),
          payload: { runId: "codex_task-packet" }
        };
      },
      async cancelRun() {
        return;
      },
      async getResult() {
        return {
          runId: "codex_task-packet",
          status: "completed" as const,
          summary: "Implemented packet handoff.",
          changedFiles: ["packages/supervisor/src/index.ts"],
          diff: null,
          artifacts: [{ type: "diff", ref: "codex_task-packet.diff" }],
          testsRun: ["pnpm test"],
          risks: [],
          followups: [],
          scriptizationCandidates: ["Promote packet builder into shared utility."],
          blockers: []
        };
      }
    };

    const supervisorRuntime = {
      plan: vi.fn(async () => ({
        steps: [
          {
            id: "plan-code",
            title: "Implement packet handoff",
            description: "Build and pass a typed execution packet.",
            subagent: "coder" as const,
            acceptanceCriteria: ["execution_packet contains acceptance criteria"]
          }
        ],
        estimatedCost: 0.1,
        routingProfile: "balanced" as const,
        approvalRequired: false,
        routeDecision: buildRouteDecision("Implement packet handoff")
      })),
      synthesize: vi.fn(async () => ({
        summary: "Synthesis complete.",
        artifacts: [],
        verdict: "pass" as const,
        scriptizationCandidates: ["Persist common handoff defaults in code."]
      })),
      verify: vi.fn(async () => ({
        verdict: "pass" as const,
        reason: "Looks good",
        risks: [],
        missingChecks: []
      }))
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime,
      coderRuntime
    });

    expect(startRunInput).toEqual(
      expect.objectContaining({
        taskId: "task-packet",
        mode: "PATCH_AND_TEST",
        executionPacket: expect.objectContaining({
          taskId: "task-packet",
          goal: "Implement packet handoff",
          repo: "github.com/org/repo",
          scope: "task",
          toolsAllowed: expect.arrayContaining(["read", "edit", "test", "git"]),
          acceptanceCriteria: expect.arrayContaining(["execution_packet contains acceptance criteria"]),
          artifactsRequired: expect.arrayContaining(["summary", "diff", "tests", "result_packet"])
        })
      })
    );
  });

  it("stops after planning when supervisor requires approval", async () => {
    const transitions: string[] = [];
    const events: string[] = [];
    const statuses: string[] = [];
    const taskRecord = {
      id: "task-approval",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Implement risky change",
      rawInput: "Implement risky change",
      normalizedInput: "Implement risky change",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
        events.push(type);
        if (type === "task.planned") {
          taskRecord.taskEvents = [{ type, payload }];
        }
        return null;
      }),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        transitions.push(nextState);
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const approvalRuntime = {
      plan: vi.fn(async () => ({
        steps: [
          {
            id: "plan-1",
            title: "Get approval",
            description: "Needs approval before execution.",
            subagent: "supervisor" as const,
            acceptanceCriteria: ["Approval granted"]
          }
        ],
        estimatedCost: 0.12,
        routingProfile: "balanced" as const,
        approvalRequired: true,
        routeDecision: { ...buildRouteDecision("Implement risky change"), executionType: "human_approval" as const }
      })),
      synthesize: vi.fn(),
      verify: vi.fn()
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime: approvalRuntime,
      coderRuntime: new MockCodexRuntime(),
      onStatusUpdate: async (stage) => {
        statuses.push(stage);
      }
    });

    expect(transitions).toEqual(["PLANNING", "AWAITING_APPROVAL"]);
    expect(statuses).toEqual(["planning"]);
    expect(events).toEqual(expect.arrayContaining(["task.planned", "approval.requested"]));
    expect(events).not.toEqual(expect.arrayContaining(["subagent.dispatched", "task.completed"]));
    expect(approvalRuntime.synthesize).not.toHaveBeenCalled();
    expect(approvalRuntime.verify).not.toHaveBeenCalled();
  });

  it("skips the coder pipeline for answer_self plans", async () => {
    const transitions: string[] = [];
    const events: string[] = [];
    const statuses: string[] = [];
    const eventPayloads = new Map<string, Record<string, unknown>>();
    const taskRecord = {
      id: "task-answer-self",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Explain the architecture",
      rawInput: "Explain the architecture",
      normalizedInput: "Explain the architecture",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
        events.push(type);
        eventPayloads.set(type, payload);
        return null;
      }),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        transitions.push(nextState);
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const coderRuntime = {
      startRun: vi.fn(),
      streamEvents: vi.fn(),
      cancelRun: vi.fn(),
      getResult: vi.fn()
    };

    const supervisorRuntime = {
      plan: vi.fn(async () => ({
        steps: [],
        estimatedCost: 0.01,
        routingProfile: "balanced" as const,
        approvalRequired: false,
        routeDecision: {
          goal: "Explain the architecture",
          scope: "task" as const,
          executionType: "answer_self" as const,
          capabilityId: null,
          whyThisPath: "The supervisor already knows the answer.",
          whyNotCheaperPath: "This is already the cheapest path.",
          risk: "low" as const,
          budgetClass: "cheap" as const,
          expectedArtifacts: ["summary"],
          fallback: "Escalate if more detail is required."
        },
        directAnswer: "Система состоит из frontdesk, supervisor и worker."
      })),
      synthesize: vi.fn(),
      verify: vi.fn()
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime,
      coderRuntime,
      onStatusUpdate: async (stage) => {
        statuses.push(stage);
      }
    });

    expect(coderRuntime.startRun).not.toHaveBeenCalled();
    expect(supervisorRuntime.synthesize).not.toHaveBeenCalled();
    expect(supervisorRuntime.verify).not.toHaveBeenCalled();
    expect(transitions).toEqual(["PLANNING", "RUNNING", "COMPLETED"]);
    expect(statuses).toEqual(["planning", "completed"]);
    expect(events).toEqual(
      expect.arrayContaining(["task.planned", "task.synthesized", "task.completed", "improvement.note"])
    );
    expect(events).not.toEqual(
      expect.arrayContaining(["subagent.dispatched", "coder.result_packet", "verifier.completed"])
    );
    expect(eventPayloads.get("task.synthesized")).toMatchObject({
      summary: "Система состоит из frontdesk, supervisor и worker."
    });
    expect(eventPayloads.get("task.completed")).toMatchObject({
      summary: "Система состоит из frontdesk, supervisor и worker."
    });
  });

  it("uses the answer_self synthesis fallback prompt and appends referenced file content", async () => {
    const transitions: string[] = [];
    const events: string[] = [];
    const statuses: string[] = [];
    const eventPayloads = new Map<string, Record<string, unknown>>();
    const docsDir = `${process.cwd()}/docs`;
    const filePath = `${docsDir}/test-answer-self.md`;
    const fileContent = "# Economics\nRouting should stay cheap for read-only tasks.\n";

    await mkdir(docsDir, { recursive: true });
    await writeFile(filePath, fileContent, "utf-8");

    const taskRecord = {
      id: "task-answer-self-fallback",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Read docs/test-answer-self.md",
      rawInput: "Read docs/test-answer-self.md and summarize it",
      normalizedInput: "Read docs/test-answer-self.md and summarize it",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
        events.push(type);
        eventPayloads.set(type, payload);
        return null;
      }),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        transitions.push(nextState);
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const coderRuntime = {
      startRun: vi.fn(),
      streamEvents: vi.fn(),
      cancelRun: vi.fn(),
      getResult: vi.fn()
    };

    const supervisorRuntime = {
      plan: vi.fn(async () => ({
        steps: [],
        estimatedCost: 0.01,
        routingProfile: "balanced" as const,
        approvalRequired: false,
        routeDecision: {
          goal: "Read docs/test-answer-self.md",
          scope: "task" as const,
          executionType: "answer_self" as const,
          capabilityId: null,
          whyThisPath: "This is a read-only repository question.",
          whyNotCheaperPath: "This is already the cheapest path.",
          risk: "low" as const,
          budgetClass: "cheap" as const,
          expectedArtifacts: ["summary"],
          fallback: "Escalate if edits are requested."
        },
        directAnswer: null
      })),
      synthesize: vi.fn(async (_task, _results, context) => {
        expect(context).toMatchObject({
          instruction: expect.stringContaining('The user asked: "Read docs/test-answer-self.md and summarize it".')
        });
        expect((context as { instruction: string }).instruction).toContain(`You have access to the repository at ${process.cwd()}.`);
        expect((context as { instruction: string }).instruction).toContain("If the user references a file, READ it and include its content in your answer.");
        expect(context).toMatchObject({
          contextBundle: null
        });

        return {
          summary: "Кратко.",
          artifacts: [],
          verdict: "pass" as const,
          scriptizationCandidates: []
        };
      }),
      verify: vi.fn()
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    try {
      await runSupervisor(taskRecord.id, {
        supervisorRuntime,
        coderRuntime,
        onStatusUpdate: async (stage) => {
          statuses.push(stage);
        }
      });
    } finally {
      await rm(filePath, { force: true });
    }

    expect(coderRuntime.startRun).not.toHaveBeenCalled();
    expect(supervisorRuntime.synthesize).toHaveBeenCalledTimes(1);
    expect(supervisorRuntime.verify).not.toHaveBeenCalled();
    expect(transitions).toEqual(["PLANNING", "RUNNING", "COMPLETED"]);
    expect(statuses).toEqual(["planning", "completed"]);
    expect(events).toEqual(
      expect.arrayContaining(["task.planned", "task.synthesized", "task.completed", "improvement.note"])
    );
    expect(eventPayloads.get("task.synthesized")).toMatchObject({
      summary: expect.stringContaining("Кратко.")
    });
    expect(eventPayloads.get("task.synthesized")?.summary).toContain(fileContent.trim());
    expect(eventPayloads.get("task.completed")?.summary).toContain(fileContent.trim());
  });

  it("resumes after approval without replanning", async () => {
    const transitions: string[] = [];
    const events: string[] = [];
    const statuses: string[] = [];
    const taskRecord = {
      id: "task-resume",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Resume approved task",
      rawInput: "Resume approved task",
      normalizedInput: "Resume approved task",
      state: "RUNNING",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [
        {
          type: "task.planned",
          payload: {
            plan: [
              {
                id: "saved-step",
                title: "Implement",
                description: "Continue execution.",
                subagent: "coder",
                acceptanceCriteria: ["Done"]
              }
            ],
            estimatedCost: 0.09,
            routingProfile: "balanced",
            approvalRequired: true,
            routeDecision: buildRouteDecision("Resume approved task")
          }
        }
      ] as MockTaskEvent[]
    };

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async ({ type }: { type: string }) => {
        events.push(type);
        return null;
      }),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        transitions.push(nextState);
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const resumeRuntime = {
      plan: vi.fn(async () => ({
        steps: [],
        estimatedCost: 0,
        routingProfile: "balanced" as const,
        approvalRequired: false,
        routeDecision: buildRouteDecision("Resume approved task")
      })),
      synthesize: vi.fn(async (_task, subagentResults) => ({
        summary: `Synthesized ${subagentResults.length} results`,
        artifacts: [],
        verdict: "pass" as const,
        scriptizationCandidates: ["Persist approval-resume replay as a workflow."]
      })),
      verify: vi.fn(async () => ({
        verdict: "pass" as const,
        reason: "Accepted",
        risks: [],
        missingChecks: []
      }))
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime: resumeRuntime,
      coderRuntime: new MockCodexRuntime(),
      resumeAfterApproval: true,
      onStatusUpdate: async (stage) => {
        statuses.push(stage);
      }
    });

    expect(resumeRuntime.plan).not.toHaveBeenCalled();
    expect(transitions).toEqual(["VERIFYING", "COMPLETED"]);
    expect(statuses).toEqual(["researching", "coding", "verifying", "completed"]);
    expect(events).toEqual(
      expect.arrayContaining([
        "subagent.dispatched",
        "subagent.completed",
        "coder.result_packet",
        "verifier.completed",
        "task.synthesized",
        "task.completed",
        "improvement.note"
      ])
    );
  });

  it("emits an improvement.note event after a non-trivial task", async () => {
    const taskRecord = {
      id: "task-improvement",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Capture improvements",
      rawInput: "Capture improvements",
      normalizedInput: "Capture improvements",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };
    const capturedEvents: MockTaskEvent[] = [];

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async ({ type, payload }: MockTaskEvent) => {
        capturedEvents.push({ type, payload });
        return null;
      }),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record() {
          return { estimatedCostUsd: 0.01 };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage() {
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const supervisorRuntime = {
      plan: vi.fn(async () => ({
        steps: [],
        estimatedCost: 0.1,
        routingProfile: "balanced" as const,
        approvalRequired: false,
        routeDecision: buildRouteDecision("Capture improvements")
      })),
      synthesize: vi.fn(async () => ({
        summary: "Done.",
        artifacts: [],
        verdict: "pass" as const,
        scriptizationCandidates: ["Move supervisor synthesis heuristics into a helper."]
      })),
      verify: vi.fn(async () => ({
        verdict: "pass" as const,
        reason: "Accepted",
        risks: [],
        missingChecks: []
      }))
    };

    const coderRuntime = {
      startRun: vi.fn(async () => ({ runId: "codex_task-improvement" })),
      async *streamEvents() {
        yield {
          type: "codex.run.completed",
          createdAt: new Date().toISOString(),
          payload: { runId: "codex_task-improvement" }
        };
      },
      async cancelRun() {
        return;
      },
      async getResult() {
        return {
          runId: "codex_task-improvement",
          status: "completed" as const,
          summary: "Completed.",
          changedFiles: [],
          diff: null,
          artifacts: [],
          testsRun: ["pnpm test"],
          risks: [],
          followups: ["Add regression fixture for improvement notes."],
          scriptizationCandidates: ["Emit improvement.note through a shared event helper."],
          blockers: []
        };
      }
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime,
      coderRuntime
    });

    expect(capturedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "improvement.note",
          payload: expect.objectContaining({
            scriptizationCandidates: expect.arrayContaining([
              "Move supervisor synthesis heuristics into a helper.",
              "Emit improvement.note through a shared event helper."
            ]),
            followups: ["Add regression fixture for improvement notes."],
            promptToCodeCandidates: expect.arrayContaining([
              "Move supervisor synthesis heuristics into a helper.",
              "Emit improvement.note through a shared event helper."
            ])
          })
        })
      ])
    );
  });

  it("records real supervisor usage when runtime returns cost data", async () => {
    const recordCalls: Array<Record<string, unknown>> = [];
    const snapshotCalls: Array<Record<string, unknown>> = [];
    const taskRecord = {
      id: "task-usage",
      userId: "user-42",
      channel: "telegram",
      threadId: "chat-42",
      title: "Track Claude usage",
      rawInput: "Track Claude usage",
      normalizedInput: "Track Claude usage",
      state: "INTAKE_NORMALIZED",
      repoRefs: [],
      priority: "normal",
      routingProfile: "balanced",
      budgetPolicyId: "budget-42",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      budgetPolicy: {
        id: "budget-42",
        name: "default",
        maxTaskCostUsd: 10,
        maxTaskTokens: 100000,
        maxOpusCalls: 10,
        maxCodexRuns: 5,
        maxWallTimeMinutes: 60,
        warnAtPercent: 75,
        stopAtPercent: 100
      },
      costSnapshots: [],
      taskEvents: [] as MockTaskEvent[]
    };

    vi.doMock("@agent-platform/core", () => ({
      prisma: {
        task: {
          findUniqueOrThrow: vi.fn(async () => taskRecord)
        }
      },
      appendTaskEvent: vi.fn(async () => null),
      transitionTaskState: vi.fn(async (_taskId: string, nextState: string) => {
        taskRecord.state = nextState as typeof taskRecord.state;
        return taskRecord;
      })
    }));

    vi.doMock("@agent-platform/model-gateway", () => ({
      StaticPricingCatalog: class {},
      PrismaLlmCallLogger: class {
        async record(input: Record<string, unknown>) {
          recordCalls.push(input);
          return { estimatedCostUsd: Number(input.estimatedCostUsd ?? 0) };
        }
      },
      PrismaTaskCostSnapshotUpdater: class {
        async applyUsage(input: Record<string, unknown>) {
          snapshotCalls.push(input);
          return;
        }
      }
    }));

    vi.doMock("@agent-platform/observability", () => ({
      createLogger: () => ({
        child: () => ({
          info: vi.fn(),
          error: vi.fn()
        })
      })
    }));

    vi.doMock("@agent-platform/memory-service", () => ({
      MemoryService: class {
        async rememberTaskSummary() {
          return;
        }
      }
    }));

    const usageRuntime = {
      plan: vi.fn(async () => ({
        steps: [],
        estimatedCost: 0.12,
        routingProfile: "balanced" as const,
        approvalRequired: false,
        routeDecision: buildRouteDecision("Track Claude usage"),
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          costUsd: 0.018,
          model: "claude-sonnet-4"
        }
      })),
      synthesize: vi.fn(async () => ({
        summary: "Final synthesis summary from Claude.",
        artifacts: [],
        verdict: "pass" as const,
        scriptizationCandidates: ["Persist usage accounting assertions in a shared fixture."],
        usage: {
          inputTokens: 80,
          outputTokens: 30,
          costUsd: 0.01,
          model: "claude-sonnet-4"
        }
      })),
      verify: vi.fn(async () => ({
        verdict: "pass" as const,
        reason: "Checks passed",
        risks: [],
        missingChecks: [],
        usage: {
          inputTokens: 60,
          outputTokens: 20,
          costUsd: 0.007,
          model: "claude-sonnet-4"
        }
      }))
    };

    const { runSupervisor } = await import("../../packages/supervisor/src/index.js");

    await runSupervisor(taskRecord.id, {
      supervisorRuntime: usageRuntime,
      coderRuntime: new MockCodexRuntime()
    });

    const anthropicCalls = recordCalls.filter((call) => call.provider === "anthropic");
    expect(anthropicCalls).toHaveLength(3);
    expect(anthropicCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subagentId: "planner",
          model: "claude-sonnet-4",
          promptTokens: 120,
          completionTokens: 45,
          estimatedCostUsd: 0.018
        }),
        expect.objectContaining({
          subagentId: "verifier",
          model: "claude-sonnet-4",
          promptTokens: 60,
          completionTokens: 20,
          estimatedCostUsd: 0.007
        }),
        expect.objectContaining({
          subagentId: "synthesizer",
          model: "claude-sonnet-4",
          promptTokens: 80,
          completionTokens: 30,
          estimatedCostUsd: 0.01
        })
      ])
    );

    const anthropicSnapshots = snapshotCalls.filter((call) => call.modelKey === "anthropic/claude-sonnet-4");
    expect(anthropicSnapshots).toHaveLength(3);
    expect(anthropicSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputTokens: 120,
          outputTokens: 45,
          estimatedCostUsd: 0.018
        }),
        expect.objectContaining({
          inputTokens: 60,
          outputTokens: 20,
          estimatedCostUsd: 0.007
        }),
        expect.objectContaining({
          inputTokens: 80,
          outputTokens: 30,
          estimatedCostUsd: 0.01
        })
      ])
    );
  });
});
