import { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MockCodexRuntime } from "@agent-platform/codex-runtime";
import { prisma } from "@agent-platform/core";
import { appendTaskEvent, transitionTaskState } from "@agent-platform/core";
import {
  CoderRuntime,
  ContextBundle,
  ExecutionPacket,
  SubagentResult,
  SupervisorPlan,
  SupervisorRuntime,
  SupervisorUsage,
  Task
} from "@agent-platform/contracts";
import {
  PrismaLlmCallLogger,
  PrismaTaskCostSnapshotUpdater,
  StaticPricingCatalog
} from "@agent-platform/model-gateway";
import { EmailClient, HttpN8nClient, N8nClient, SmtpEmailClient } from "@agent-platform/integrations";
import { createLogger } from "@agent-platform/observability";
import { checkBudget } from "@agent-platform/policy-engine";
import { MockSupervisorRuntime } from "@agent-platform/supervisor-runtime";
import { MemoryService } from "@agent-platform/memory-service";

const logger = createLogger().child({ component: "supervisor" });
const pricingCatalog = new StaticPricingCatalog([
  {
    provider: "mock",
    model: "researcher-v1",
    pricingVersion: "2026-04-06",
    inputCostPer1m: 0.5,
    outputCostPer1m: 1,
    cachedInputDiscount: 0.2,
    effectiveFrom: "2026-04-06T00:00:00.000Z"
  },
  {
    provider: "mock",
    model: "codex-v1",
    pricingVersion: "2026-04-06",
    inputCostPer1m: 15,
    outputCostPer1m: 30,
    cachedInputDiscount: 0.25,
    effectiveFrom: "2026-04-06T00:00:00.000Z"
  }
]);
const llmCallLogger = new PrismaLlmCallLogger(pricingCatalog);
const snapshotUpdater = new PrismaTaskCostSnapshotUpdater();

export interface RunSupervisorDependencies {
  supervisorRuntime?: SupervisorRuntime;
  coderRuntime?: CoderRuntime;
  memoryService?: MemoryService;
  contextBundle?: ContextBundle | null;
  onStatusUpdate?: (stage: SupervisorStage) => Promise<void> | void;
  resumeAfterApproval?: boolean;
  emailClient?: EmailClient;
  n8nClient?: N8nClient;
}

export type SupervisorStage = "planning" | "researching" | "coding" | "verifying" | "completed";

function mockBudgetUsage(model: string) {
  return {
    inputTokens: 1_000,
    outputTokens: 400,
    estimatedUsd: model === "codex" ? 0.08 : 0.01
  };
}

export async function runSupervisor(
  taskId: string,
  dependencies: RunSupervisorDependencies = {}
): Promise<void> {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      budgetPolicy: true,
      costSnapshots: { take: 1, orderBy: { createdAt: "desc" } },
      taskEvents: {
        where: { type: "task.planned" },
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });

  const supervisorRuntime = dependencies.supervisorRuntime ?? new MockSupervisorRuntime();
  const coderRuntime = dependencies.coderRuntime ?? new MockCodexRuntime();
  const memoryService = dependencies.memoryService ?? new MemoryService();
  const onStatusUpdate = dependencies.onStatusUpdate;
  const resumeAfterApproval = dependencies.resumeAfterApproval ?? false;
  const contextBundle = dependencies.contextBundle ?? null;
  const emailClient = dependencies.emailClient ?? new SmtpEmailClient();
  const n8nClient = dependencies.n8nClient ?? new HttpN8nClient();
  const contractTask = toContractTask(task);

  if (!resumeAfterApproval && (task.state === "INTAKE_NORMALIZED" || task.state === "FAILED" || task.state === "PAUSED")) {
    await transitionTaskState(taskId, "PLANNING");
  }

  let plan = getPersistedPlan(task.taskEvents?.[0]?.payload, contractTask);

  if (!resumeAfterApproval) {
    await onStatusUpdate?.("planning");

    const planStartedAt = Date.now();
    plan = await supervisorRuntime.plan(contractTask, {
      latestCostSnapshot: task.costSnapshots[0] ?? null,
      contextBundle
    });
    await recordSupervisorUsage(taskId, "planner", "supervisor", "planning", plan.usage, Date.now() - planStartedAt);

    await appendTaskEvent({
      taskId,
      type: "task.planned",
      actor: "supervisor",
      payload: toPrismaJson({
        plan: plan.steps,
        estimatedCost: plan.estimatedCost,
        routingProfile: plan.routingProfile,
        approvalRequired: plan.approvalRequired,
        routeDecision: plan.routeDecision,
        directAnswer: plan.directAnswer
      })
    });

    if (plan.routeDecision.executionType === "human_approval" && !isPostApprovalState(task.state)) {
      if (task.state !== "AWAITING_APPROVAL") {
        await transitionTaskState(taskId, "AWAITING_APPROVAL");
      }

      await appendTaskEvent({
        taskId,
        type: "approval.requested",
        actor: "supervisor",
        payload: toPrismaJson({
          reason: "Supervisor plan requires approval before execution.",
          plan: plan.steps
        })
      });
      return;
    }
  }

  const latestSnapshot = task.costSnapshots[0] ?? {
    totalEstimatedCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalWallTimeMs: 0,
    modelBreakdownJson: {}
  };

  const budgetResult = checkBudget(
    {
      id: task.budgetPolicy.id,
      name: task.budgetPolicy.name,
      maxTaskCostUsd: task.budgetPolicy.maxTaskCostUsd,
      maxTaskTokens: task.budgetPolicy.maxTaskTokens,
      maxOpusCalls: task.budgetPolicy.maxOpusCalls,
      maxCodexRuns: task.budgetPolicy.maxCodexRuns,
      maxWallTimeMinutes: task.budgetPolicy.maxWallTimeMinutes,
      warnAtPercent: task.budgetPolicy.warnAtPercent,
      stopAtPercent: task.budgetPolicy.stopAtPercent
    },
    {
      totalEstimatedCostUsd: latestSnapshot.totalEstimatedCostUsd,
      totalInputTokens: latestSnapshot.totalInputTokens,
      totalOutputTokens: latestSnapshot.totalOutputTokens,
      totalWallTimeMs: latestSnapshot.totalWallTimeMs,
      modelBreakdown: latestSnapshot.modelBreakdownJson as Record<string, number>
    }
  );

  if (budgetResult.hardStop) {
    await transitionTaskState(taskId, "FAILED");
    await appendTaskEvent({
      taskId,
      type: "task.failed",
      actor: "supervisor",
      payload: { reason: "Budget hard stop reached" }
    });
    return;
  }

  if (task.state !== "RUNNING") {
    await transitionTaskState(taskId, "RUNNING");
  }

  const serviceAction = resolveServiceAction(task.normalizedInput);
  if (serviceAction) {
    await handleServiceAction({
      taskId,
      task: contractTask,
      action: serviceAction,
      emailClient,
      n8nClient,
      memoryService,
      onStatusUpdate
    });
    return;
  }

  if (
    plan.routeDecision.executionType === "answer_self"
  ) {
    let directAnswer = plan.directAnswer;

    // If Claude didn't fill directAnswer, make a dedicated synthesize call to get the actual answer
    if (!directAnswer || directAnswer.trim().length === 0) {
      logger.info({ taskId }, "directAnswer is empty for answer_self — making dedicated answer call");
      const answerSynthesis = await supervisorRuntime.synthesize(contractTask, [], {
        contextBundle,
        instruction: `The user asked: "${contractTask.normalizedInput}".
You have access to the repository at ${process.cwd()}.
If the user references a file, READ it and include its content in your answer.
Answer the question FULLY, DIRECTLY, and SPECIFICALLY.
This answer will be sent directly to the user as the final response.
Use Russian if the question is in Russian.`
      });
      directAnswer = answerSynthesis.summary;
      if (answerSynthesis.usage) {
        await recordSupervisorUsage(taskId, "supervisor", "supervisor", "answer_self_fallback", answerSynthesis.usage, 0);
      }
    }

    if (shouldAppendReferencedFileContent(contractTask.normalizedInput, directAnswer)) {
      const referencedFileContent = await tryReadReferencedFile(contractTask.normalizedInput);
      if (referencedFileContent) {
        directAnswer = directAnswer && directAnswer.trim().length > 0
          ? `${directAnswer}\n\n${referencedFileContent}`
          : referencedFileContent;
      }
    }

    const synthesis = {
      summary: directAnswer || resolveDirectAnswer(plan, contractTask),
      artifacts: [],
      verdict: "pass" as const,
      scriptizationCandidates: [],
      proposedPolicyPatch: null
    };

    await appendTaskEvent({
      taskId,
      type: "task.synthesized",
      actor: "supervisor",
      payload: toPrismaJson(synthesis)
    });

    await transitionTaskState(taskId, "COMPLETED");
    await appendTaskEvent({
      taskId,
      type: "task.completed",
      actor: "supervisor",
      payload: toPrismaJson({
        summary: directAnswer,
        verifier: null,
        artifacts: [],
        proposedPolicyPatch: null
      })
    });

    await appendTaskEvent({
      taskId,
      type: "improvement.note",
      actor: "supervisor",
      payload: toPrismaJson({
        scriptizationCandidates: uniqueStrings(synthesis.scriptizationCandidates),
        followups: [],
        promptToCodeCandidates: uniqueStrings(synthesis.scriptizationCandidates)
      })
    });

    await memoryService.rememberTaskSummary({
      taskId,
      summary: synthesis.summary,
      accepted: true
    });

    await onStatusUpdate?.("completed");

    logger.info({ taskId, executionType: plan.routeDecision.executionType }, "Task completed without coder pipeline");
    return;
  }

  if (
    plan.routeDecision.executionType === "script" ||
    plan.routeDecision.executionType === "workflow"
  ) {
    const directResult: SubagentResult = {
      status: "completed",
      summary: resolveDirectAnswer(plan, contractTask),
      confidence: 0.82,
      risks: [],
      nextActions: [],
      artifacts: [],
      budgetUsed: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: 0
      }
    };

    const synthesizeStartedAt = Date.now();
    const synthesis = await supervisorRuntime.synthesize(contractTask, [directResult], { contextBundle });
    await recordSupervisorUsage(taskId, "synthesizer", "supervisor", "synthesis", synthesis.usage, Date.now() - synthesizeStartedAt);

    await appendTaskEvent({
      taskId,
      type: "task.synthesized",
      actor: "supervisor",
      payload: toPrismaJson(synthesis)
    });

    await transitionTaskState(taskId, "COMPLETED");
    await appendTaskEvent({
      taskId,
      type: "task.completed",
      actor: "supervisor",
      payload: toPrismaJson({
        summary: synthesis.summary,
        verifier: null,
        artifacts: synthesis.artifacts,
        proposedPolicyPatch: synthesis.proposedPolicyPatch ?? null
      })
    });

    await appendTaskEvent({
      taskId,
      type: "improvement.note",
      actor: "supervisor",
      payload: toPrismaJson({
        scriptizationCandidates: uniqueStrings(synthesis.scriptizationCandidates),
        followups: [],
        promptToCodeCandidates: uniqueStrings(synthesis.scriptizationCandidates)
      })
    });

    await memoryService.rememberTaskSummary({
      taskId,
      summary: synthesis.summary,
      accepted: true
    });

    await onStatusUpdate?.("completed");

    logger.info({ taskId, executionType: plan.routeDecision.executionType }, "Task completed without coder pipeline");
    return;
  }

  await onStatusUpdate?.("researching");

  await appendTaskEvent({
    taskId,
    type: "subagent.dispatched",
    actor: "supervisor",
    payload: { subagent: "researcher", planStepIds: plan.steps.map((step) => step.id) }
  });

  const researcherResult: SubagentResult = {
    status: "completed",
    summary: "Mock researcher reviewed the task and prepared a concise brief.",
    confidence: 0.72,
    risks: [],
    nextActions: ["Invoke coder"],
    artifacts: [{ type: "note", ref: `task://${taskId}/research-brief` }],
    budgetUsed: mockBudgetUsage("researcher")
  };

  await appendTaskEvent({
    taskId,
    type: "subagent.completed",
    actor: "researcher",
    payload: toPrismaJson(researcherResult)
  });

  const researcherUsage = await llmCallLogger.record({
    taskId,
    subagentId: "researcher",
    actor: "researcher",
    provider: "mock",
    model: "researcher-v1",
    purpose: "research",
    promptTokens: 700,
    completionTokens: 300,
    cachedTokens: 0,
    latencyMs: 250
  });

  await snapshotUpdater.applyUsage({
    taskId,
    inputTokens: 700,
    outputTokens: 300,
    estimatedCostUsd: researcherUsage.estimatedCostUsd,
    wallTimeMs: 250,
    modelKey: "mock/researcher-v1"
  });

  await onStatusUpdate?.("coding");

  const executionPacket = buildExecutionPacket(taskId, contractTask, plan, researcherResult);
  const handle = await coderRuntime.startRun({
    taskId,
    mode: "PATCH_AND_TEST",
    executionPacket
  });

  for await (const event of coderRuntime.streamEvents(handle.runId)) {
    await appendTaskEvent({
      taskId,
      type: event.type,
      actor: "coder",
      payload: event.payload as Prisma.InputJsonValue
    });
  }

  const coderResult = await coderRuntime.getResult(handle.runId);
  await appendTaskEvent({
    taskId,
    type: "coder.result_packet",
    actor: "coder",
    payload: toPrismaJson({
      taskId,
      status: coderResult.status === "cancelled" ? "failed" : coderResult.status,
      summary: coderResult.summary,
      filesChanged: coderResult.changedFiles,
      artifacts: coderResult.artifacts.map((artifact) => artifact.ref),
      testsRun: coderResult.testsRun,
      risks: coderResult.risks,
      followups: coderResult.followups,
      scriptizationCandidates: coderResult.scriptizationCandidates,
      blockers: coderResult.blockers
    })
  });

  const coderSubagentResult: SubagentResult = {
    status:
      coderResult.status === "completed" ? "completed" : coderResult.status === "blocked" ? "blocked" : "failed",
    summary: coderResult.summary,
    confidence: 0.63,
    risks:
      coderResult.risks.length > 0
        ? coderResult.risks
        : coderResult.status === "completed"
          ? ["Stub runtime produced synthetic diff only"]
          : ["Coder runtime failed."],
    nextActions: coderResult.followups.length > 0 ? coderResult.followups : ["Run verifier"],
    artifacts: coderResult.artifacts.map((artifact) => ({
      type: normalizeArtifactType(artifact.type),
      ref: artifact.ref
    })),
    budgetUsed: mockBudgetUsage("codex")
  };

  await appendTaskEvent({
    taskId,
    type: "subagent.completed",
    actor: "coder",
    payload: toPrismaJson(coderSubagentResult)
  });

  const coderUsage = await llmCallLogger.record({
    taskId,
    subagentId: "coder",
    actor: "coder",
    provider: "mock",
    model: "codex-v1",
    purpose: "coding",
    promptTokens: 1300,
    completionTokens: 500,
    cachedTokens: 100,
    latencyMs: 950
  });

  await snapshotUpdater.applyUsage({
    taskId,
    inputTokens: 1300,
    outputTokens: 500,
    estimatedCostUsd: coderUsage.estimatedCostUsd,
    wallTimeMs: 950,
    modelKey: "mock/codex-v1"
  });

  await transitionTaskState(taskId, "VERIFYING");
  await onStatusUpdate?.("verifying");

  const verifyStartedAt = Date.now();
  const verifierResult = await supervisorRuntime.verify(contractTask, coderResult, { contextBundle });
  await recordSupervisorUsage(taskId, "verifier", "verifier", "verification", verifierResult.usage, Date.now() - verifyStartedAt);

  await appendTaskEvent({
    taskId,
    type: "verifier.completed",
    actor: "verifier",
    payload: toPrismaJson(verifierResult)
  });

  const synthesizeStartedAt = Date.now();
  const synthesis = await supervisorRuntime.synthesize(contractTask, [
    researcherResult,
    coderSubagentResult
  ], { contextBundle });
  await recordSupervisorUsage(taskId, "synthesizer", "supervisor", "synthesis", synthesis.usage, Date.now() - synthesizeStartedAt);

  await appendTaskEvent({
    taskId,
    type: "task.synthesized",
    actor: "supervisor",
    payload: toPrismaJson(synthesis)
  });

  await transitionTaskState(taskId, verifierResult.verdict === "pass" ? "COMPLETED" : "FAILED");
  await appendTaskEvent({
    taskId,
    type: verifierResult.verdict === "pass" ? "task.completed" : "task.failed",
    actor: "supervisor",
    payload: toPrismaJson({
      summary: synthesis.summary,
      verifier: verifierResult,
      artifacts: synthesis.artifacts,
      proposedPolicyPatch: synthesis.proposedPolicyPatch ?? null
    })
  });

  await appendTaskEvent({
    taskId,
    type: "improvement.note",
    actor: "supervisor",
    payload: toPrismaJson({
      scriptizationCandidates: uniqueStrings([
        ...synthesis.scriptizationCandidates,
        ...coderResult.scriptizationCandidates
      ]),
      followups: uniqueStrings(coderResult.followups),
      promptToCodeCandidates: uniqueStrings([
        ...synthesis.scriptizationCandidates,
        ...coderResult.scriptizationCandidates
      ])
    })
  });

  await memoryService.rememberTaskSummary({
    taskId,
    summary: synthesis.summary,
    accepted: verifierResult.verdict === "pass"
  });

  await onStatusUpdate?.("completed");

  logger.info({ taskId, verdict: verifierResult.verdict }, "Task processed by supervisor");
}

function getPersistedPlan(value: unknown, task: Task): SupervisorPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      steps: [],
      estimatedCost: 0,
      routingProfile: task.routingProfile,
      approvalRequired: false,
      routeDecision: buildFallbackRouteDecision(task),
      directAnswer: null,
      usage: undefined
    };
  }

  const payload = value as Record<string, unknown>;
  return {
    steps: Array.isArray(payload.plan)
      ? payload.plan.flatMap((step) => {
          if (!step || typeof step !== "object" || Array.isArray(step)) {
            return [];
          }

          const candidate = step as Record<string, unknown>;
          if (
            typeof candidate.id !== "string" ||
            typeof candidate.title !== "string" ||
            typeof candidate.description !== "string" ||
            !Array.isArray(candidate.acceptanceCriteria) ||
            (candidate.subagent !== "researcher" &&
              candidate.subagent !== "coder" &&
              candidate.subagent !== "verifier" &&
              candidate.subagent !== "supervisor")
          ) {
            return [];
          }

          return [
            {
              id: candidate.id,
              title: candidate.title,
              description: candidate.description,
              subagent: candidate.subagent,
              acceptanceCriteria: candidate.acceptanceCriteria.filter(
                (item): item is string => typeof item === "string"
              )
            }
          ];
        })
      : [],
    estimatedCost: typeof payload.estimatedCost === "number" ? payload.estimatedCost : 0,
    routingProfile:
      payload.routingProfile === "cheap_first" ||
      payload.routingProfile === "balanced" ||
      payload.routingProfile === "quality_first" ||
      payload.routingProfile === "latency_first"
        ? payload.routingProfile
        : task.routingProfile,
    approvalRequired: typeof payload.approvalRequired === "boolean" ? payload.approvalRequired : false,
    routeDecision: parsePersistedRouteDecision(payload.routeDecision, task),
    directAnswer:
      typeof payload.directAnswer === "string"
        ? payload.directAnswer
        : payload.directAnswer === null
          ? null
        : typeof payload.answer === "string"
          ? payload.answer
          : typeof payload.content === "string"
            ? payload.content
            : null,
    usage: undefined
  };
}

function isPostApprovalState(state: Task["state"]) {
  return (
    state === "RUNNING" ||
    state === "VERIFYING" ||
    state === "AWAITING_HUMAN" ||
    state === "COMPLETED" ||
    state === "CANCELLED"
  );
}

type PrismaTaskRecord = Awaited<ReturnType<typeof prisma.task.findUniqueOrThrow>>;

function toContractTask(task: PrismaTaskRecord): Task {
  return {
    id: task.id,
    userId: task.userId,
    channel: task.channel,
    threadId: task.threadId,
    title: task.title,
    rawInput: task.rawInput,
    normalizedInput: task.normalizedInput,
    state: task.state,
    repoRefs: task.repoRefs,
    priority: task.priority,
    routingProfile: task.routingProfile,
    budgetPolicyId: task.budgetPolicyId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString()
  };
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function buildExecutionPacket(
  taskId: string,
  task: Task,
  plan: SupervisorPlan,
  researcherResult: SubagentResult
): ExecutionPacket {
  const coderSteps = plan.steps.filter((step) => step.subagent === "coder");
  const acceptanceCriteria = uniqueStrings([
    ...coderSteps.flatMap((step) => step.acceptanceCriteria),
    ...plan.routeDecision.expectedArtifacts.map((artifact) => `Produce ${artifact}`),
    "Do not break existing functionality."
  ]);

  return {
    taskId,
    goal: plan.routeDecision.goal || task.title,
    repo: task.repoRefs[0],
    scope: plan.routeDecision.scope,
    problemStatement: uniqueStrings([task.normalizedInput, researcherResult.summary]).join("\n\n"),
    acceptanceCriteria,
    constraints: uniqueStrings([
      `Routing profile: ${task.routingProfile}`,
      "Respect AGENTS.md engineering rules.",
      "Do not break existing functionality.",
      ...researcherResult.risks
    ]),
    allowedPaths: ["apps/**", "packages/**", "tests/**", "docs/**", "prisma/**", "README.md", "package.json"],
    forbiddenPaths: [".git/**", "node_modules/**"],
    toolsAllowed: ["read", "edit", "test", "git", "email", "calendar"],
    approvalRequiredFor: uniqueStrings([
      "new dependency",
      "db migration",
      "dangerous command",
      ...(plan.approvalRequired ? ["any high-risk side effect"] : [])
    ]),
    artifactsRequired: uniqueStrings([...plan.routeDecision.expectedArtifacts, "result_packet"]),
    budget: {
      timeMinutes: 45,
      tokenBudgetClass: plan.routeDecision.budgetClass
    },
    doneDefinition: uniqueStrings([
      ...acceptanceCriteria,
      "Return a valid result_packet.",
      "Run relevant tests or explain why they were skipped."
    ])
  };
}

async function handleServiceAction(input: {
  taskId: string;
  task: Task;
  action: ServiceAction;
  emailClient: EmailClient;
  n8nClient: N8nClient;
  memoryService: MemoryService;
  onStatusUpdate?: (stage: SupervisorStage) => Promise<void> | void;
}) {
  let summary: string;

  if (input.action.type === "email_send") {
    await input.emailClient.send(input.action.message);
    await appendTaskEvent({
      taskId: input.taskId,
      type: "service.email.sent",
      actor: "executor",
      payload: toPrismaJson({
        to: input.action.message.to,
        subject: input.action.message.subject
      })
    });
    summary = `Письмо отправлено на ${input.action.message.to}.`;
  } else if (input.action.type === "email_read") {
    const response = await safeCallWebhook(input.n8nClient, "mira-email-read", { taskId: input.taskId });
    await appendTaskEvent({
      taskId: input.taskId,
      type: "service.email.read",
      actor: "executor",
      payload: toPrismaJson({
        webhook: "mira-email-read",
        response
      })
    });
    summary = "Email reading via n8n — webhook not configured yet. Use /email send to send.";
  } else {
    const response = await safeCallWebhook(input.n8nClient, "mira-calendar-events", { taskId: input.taskId });
    await appendTaskEvent({
      taskId: input.taskId,
      type: "service.calendar.read",
      actor: "executor",
      payload: toPrismaJson({
        webhook: "mira-calendar-events",
        response
      })
    });
    summary = "Calendar via n8n — webhook not configured yet.";
  }

  await appendTaskEvent({
    taskId: input.taskId,
    type: "task.synthesized",
    actor: "supervisor",
    payload: toPrismaJson({
      summary,
      artifacts: [],
      verdict: "pass",
      scriptizationCandidates: [],
      proposedPolicyPatch: null
    })
  });

  await transitionTaskState(input.taskId, "COMPLETED");
  await appendTaskEvent({
    taskId: input.taskId,
    type: "task.completed",
    actor: "supervisor",
    payload: toPrismaJson({
      summary,
      verifier: null,
      artifacts: [],
      proposedPolicyPatch: null
    })
  });

  await input.memoryService.rememberTaskSummary({
    taskId: input.taskId,
    summary,
    accepted: true
  });
  await input.onStatusUpdate?.("completed");
}

async function safeCallWebhook(client: N8nClient, path: string, data: Record<string, unknown>) {
  try {
    return await client.callWebhook(path, data);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown webhook error"
    };
  }
}

type ServiceAction =
  | {
      type: "email_send";
      message: {
        to: string;
        subject: string;
        body: string;
      };
    }
  | { type: "email_read" }
  | { type: "calendar_read" };

function resolveServiceAction(input: string): ServiceAction | null {
  const emailMessage = parseEmailTask(input);
  if (emailMessage) {
    return {
      type: "email_send",
      message: emailMessage
    };
  }

  if (/(?:read email|check email|прочитай почту|проверь почту|inbox)/i.test(input)) {
    return { type: "email_read" };
  }

  if (/(?:calendar|календар|calendar events|calendar event|событи[яй])/i.test(input)) {
    return { type: "calendar_read" };
  }

  return null;
}

function parseEmailTask(input: string) {
  if (!/(?:send email|отправь письмо|напиши письмо)/i.test(input)) {
    return null;
  }

  const toMatch = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!toMatch || typeof toMatch.index !== "number") {
    return null;
  }

  const remainder = input.slice(toMatch.index + toMatch[0].length).trim();
  if (remainder.includes("|")) {
    const [subjectPart, bodyPart] = remainder.split(/\|(.+)/s);
    const subject = cleanEmailLabel(subjectPart);
    const body = bodyPart?.trim();
    if (subject && body) {
      return { to: toMatch[0], subject, body };
    }
  }

  const subjectMatch = input.match(/(?:subject|тема)\s*[:\-]\s*(.+?)(?=\s+(?:body|message|text|текст)\s*[:\-]|$)/i);
  const bodyMatch = input.match(/(?:body|message|text|текст)\s*[:\-]\s*(.+)$/i);
  if (!subjectMatch?.[1] || !bodyMatch?.[1]) {
    return null;
  }

  return {
    to: toMatch[0],
    subject: subjectMatch[1].trim(),
    body: bodyMatch[1].trim()
  };
}

function cleanEmailLabel(value: string) {
  return value.replace(/^(?:subject|тема)\s*[:\-]?\s*/i, "").trim();
}

function parsePersistedRouteDecision(value: unknown, task: Task): SupervisorPlan["routeDecision"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return buildFallbackRouteDecision(task);
  }

  const candidate = value as Record<string, unknown>;
  return {
    goal: typeof candidate.goal === "string" ? candidate.goal : task.title,
    scope:
      candidate.scope === "banter" ||
      candidate.scope === "session" ||
      candidate.scope === "task" ||
      candidate.scope === "project" ||
      candidate.scope === "user" ||
      candidate.scope === "global"
        ? candidate.scope
        : "task",
    executionType:
      candidate.executionType === "answer_self" ||
      candidate.executionType === "script" ||
      candidate.executionType === "workflow" ||
      candidate.executionType === "llm_skill" ||
      candidate.executionType === "codex" ||
      candidate.executionType === "human_approval"
        ? candidate.executionType
        : "codex",
    capabilityId: typeof candidate.capabilityId === "string" ? candidate.capabilityId : null,
    whyThisPath:
      typeof candidate.whyThisPath === "string" ? candidate.whyThisPath : "Persisted route decision omitted rationale.",
    whyNotCheaperPath:
      typeof candidate.whyNotCheaperPath === "string"
        ? candidate.whyNotCheaperPath
        : "Persisted route decision omitted cheaper-path rationale.",
    risk: candidate.risk === "low" || candidate.risk === "medium" || candidate.risk === "high" ? candidate.risk : "medium",
    budgetClass:
      candidate.budgetClass === "cheap" || candidate.budgetClass === "normal" || candidate.budgetClass === "expensive"
        ? candidate.budgetClass
        : "normal",
    expectedArtifacts: Array.isArray(candidate.expectedArtifacts)
      ? candidate.expectedArtifacts.filter((item): item is string => typeof item === "string")
      : ["summary", "diff", "tests"],
    fallback:
      typeof candidate.fallback === "string"
        ? candidate.fallback
        : "Escalate for review when the persisted route decision is incomplete."
  };
}

function buildFallbackRouteDecision(task: Task): SupervisorPlan["routeDecision"] {
  return {
    goal: task.title,
    scope: "task",
    executionType: "codex",
    capabilityId: null,
    whyThisPath: "Repository work is required for this task.",
    whyNotCheaperPath: "No deterministic workflow is persisted for this request.",
    risk: "medium",
    budgetClass: task.routingProfile === "cheap_first" ? "cheap" : "normal",
    expectedArtifacts: ["summary", "diff", "tests"],
    fallback: "Request approval or human review if execution blocks."
  };
}

function resolveDirectAnswer(plan: SupervisorPlan, task: Task): string {
  if (typeof plan.directAnswer === "string" && plan.directAnswer.trim().length > 0) {
    return plan.directAnswer;
  }

  if (typeof plan.routeDecision.goal === "string" && plan.routeDecision.goal.trim().length > 0) {
    return plan.routeDecision.goal;
  }

  const supervisorSteps = plan.steps.filter((step) => step.subagent === "supervisor");
  if (supervisorSteps.length > 0) {
    return supervisorSteps.map((step) => `${step.title}: ${step.description}`).join("\n\n");
  }

  return task.normalizedInput;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function shouldAppendReferencedFileContent(taskInput: string, answer: string | null | undefined): boolean {
  return hasReferencedFile(taskInput) && (!answer || answer.trim().length < 100);
}

function hasReferencedFile(taskInput: string): boolean {
  return /(?:docs\/|files\/|scripts\/)[^\s,]+\.[a-z]+/i.test(taskInput);
}

async function tryReadReferencedFile(taskInput: string): Promise<string | null> {
  const fileMatch = taskInput.match(/(?:docs\/|files\/|scripts\/)[^\s,]+\.[a-z]+/i);
  if (!fileMatch) {
    return null;
  }

  try {
    const content = await readFile(join(process.cwd(), fileMatch[0]), "utf-8");
    return content.slice(0, 3000);
  } catch {
    return null;
  }
}

function normalizeArtifactType(value: string): "log" | "diff" | "test_report" | "note" | "branch" | "pr" | "file" {
  if (
    value === "log" ||
    value === "diff" ||
    value === "test_report" ||
    value === "note" ||
    value === "branch" ||
    value === "pr" ||
    value === "file"
  ) {
    return value;
  }

  return "note";
}

async function recordSupervisorUsage(
  taskId: string,
  subagentId: string,
  actor: "supervisor" | "verifier",
  purpose: string,
  usage: SupervisorUsage | undefined,
  latencyMs: number
) {
  if (!usage) {
    return;
  }

  await llmCallLogger.record({
    taskId,
    subagentId,
    actor,
    provider: "anthropic",
    model: usage.model,
    purpose,
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    cachedTokens: 0,
    latencyMs,
    estimatedCostUsd: usage.costUsd
  });

  await snapshotUpdater.applyUsage({
    taskId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: usage.costUsd,
    wallTimeMs: latencyMs,
    modelKey: `anthropic/${usage.model}`
  });
}
