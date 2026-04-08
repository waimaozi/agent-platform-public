import { z } from "zod";

export const taskStateSchema = z.enum([
  "NEW",
  "INTAKE_NORMALIZED",
  "PLANNING",
  "AWAITING_APPROVAL",
  "RUNNING",
  "VERIFYING",
  "AWAITING_HUMAN",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "PAUSED"
]);

export type TaskState = z.infer<typeof taskStateSchema>;

export const actorSchema = z.enum(["system", "user", "supervisor", "researcher", "coder", "verifier", "executor"]);
export type Actor = z.infer<typeof actorSchema>;

export const messageClassificationSchema = z.enum([
  "junk",
  "banter",
  "question",
  "task_request",
  "status_query",
  "command",
  "approval_response",
  "context_update"
]);
export type MessageClassification = z.infer<typeof messageClassificationSchema>;

export const replyModeSchema = z.enum([
  "frontdesk_auto",
  "escalate_supervisor",
  "escalate_with_context",
  "silent"
]);
export type ReplyMode = z.infer<typeof replyModeSchema>;

export const memoryScopeTypeSchema = z.enum([
  "junk",
  "session_scratchpad",
  "task",
  "project",
  "user_profile",
  "pinned"
]);
export type MemoryScopeType = z.infer<typeof memoryScopeTypeSchema>;

export const memoryStatusSchema = z.enum(["candidate", "durable", "superseded", "forgotten"]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const taskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  channel: z.enum(["telegram", "slack", "admin"]),
  threadId: z.string(),
  title: z.string(),
  rawInput: z.string(),
  normalizedInput: z.string(),
  state: taskStateSchema,
  repoRefs: z.array(z.string()),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  routingProfile: z.enum(["cheap_first", "balanced", "quality_first", "latency_first"]),
  budgetPolicyId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type Task = z.infer<typeof taskSchema>;

export const eventEnvelopeSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: z.string(),
  actor: actorSchema,
  payload: z.record(z.unknown()),
  createdAt: z.string()
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const approvalRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  requestedBy: z.enum(["system", "supervisor"]),
  createdAt: z.string(),
  expiresAt: z.string().nullable()
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalDecisionSchema = z.object({
  approvalId: z.string(),
  taskId: z.string(),
  decision: z.enum(["approve", "reject"]),
  decidedByUserId: z.string(),
  comment: z.string().optional(),
  decidedAt: z.string()
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const budgetPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  maxTaskCostUsd: z.number(),
  maxTaskTokens: z.number().int(),
  maxOpusCalls: z.number().int(),
  maxCodexRuns: z.number().int(),
  maxWallTimeMinutes: z.number().int(),
  warnAtPercent: z.number(),
  stopAtPercent: z.number()
});

export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

export const userProfileSchema = z.object({
  userId: z.string(),
  language: z.string(),
  verbosity: z.enum(["short", "medium", "long"]),
  costSensitivity: z.enum(["high", "medium", "low"]),
  latencySensitivity: z.enum(["high", "medium", "low"]),
  autonomyPreference: z.enum(["manual", "balanced", "high"]),
  notifyStyle: z.enum(["every_stage", "major_only", "final_only"]),
  preferredRoutingProfile: z.enum(["cheap_first", "balanced", "quality_first", "latency_first"])
});

export type UserProfile = z.infer<typeof userProfileSchema>;

export const projectProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "on_hold", "completed", "cancelled", "planning"]),
  deadline: z.string().datetime().nullable().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  blockers: z.array(z.string()),
  lastActivityAt: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
  repoUrl: z.string().url().optional(),
  packageManager: z.string().nullable(),
  buildCommand: z.string().nullable(),
  testCommand: z.string().nullable(),
  lintCommand: z.string().nullable(),
  typecheckCommand: z.string().nullable(),
  branchPolicy: z.string().nullable(),
  prStyle: z.string().nullable(),
  dangerousDirectories: z.array(z.string()),
  knownPitfalls: z.array(z.string())
});

export type ProjectProfile = z.infer<typeof projectProfileSchema>;

export const policyPatchSchema = z.object({
  id: z.string(),
  scope: z.enum(["global", "user", "project"]),
  patchType: z.enum(["prompt_patch", "playbook_patch", "routing_patch"]),
  rationale: z.string(),
  expectedBenefit: z.string(),
  riskLevel: z.enum(["low", "medium", "high"]),
  requiresApproval: z.boolean(),
  status: z.enum(["proposed", "approved", "rejected", "applied", "rolled_back"]),
  diffJson: z.record(z.unknown())
});

export type PolicyPatch = z.infer<typeof policyPatchSchema>;

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  subagent: z.enum(["researcher", "coder", "verifier", "supervisor"]),
  acceptanceCriteria: z.array(z.string())
});

export type PlanStep = z.infer<typeof planStepSchema>;

export const budgetUsedSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estimatedUsd: z.number()
});

export const subagentArtifactSchema = z.object({
  type: z.enum(["diff", "log", "test_report", "note", "branch", "pr", "file"]),
  ref: z.string()
});

export const subagentResultSchema = z.object({
  status: z.enum(["completed", "failed", "needs_input", "blocked"]),
  summary: z.string(),
  artifacts: z.array(subagentArtifactSchema),
  confidence: z.number(),
  risks: z.array(z.string()),
  nextActions: z.array(z.string()),
  budgetUsed: budgetUsedSchema,
  proposedPolicyPatch: policyPatchSchema.nullable().optional()
});

export type SubagentResult = z.infer<typeof subagentResultSchema>;

export const coderRuntimeModeSchema = z.enum([
  "READ_ONLY_ANALYSIS",
  "PATCH_ONLY",
  "PATCH_AND_TEST",
  "PATCH_TEST_AND_PR"
]);

export type CoderRuntimeMode = z.infer<typeof coderRuntimeModeSchema>;

export const routeDecisionSchema = z.object({
  goal: z.string(),
  scope: z.enum(["banter", "session", "task", "project", "user", "global"]),
  executionType: z.enum(["answer_self", "script", "workflow", "llm_skill", "codex", "human_approval"]),
  capabilityId: z.string().nullable(),
  whyThisPath: z.string(),
  whyNotCheaperPath: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  budgetClass: z.enum(["cheap", "normal", "expensive"]),
  expectedArtifacts: z.array(z.string()),
  fallback: z.string()
});

export const executionPacketSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  repo: z.string().optional(),
  scope: z.string(),
  problemStatement: z.string(),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  allowedPaths: z.array(z.string()),
  forbiddenPaths: z.array(z.string()),
  toolsAllowed: z.array(z.string()),
  approvalRequiredFor: z.array(z.string()),
  artifactsRequired: z.array(z.string()),
  budget: z.object({
    timeMinutes: z.number(),
    tokenBudgetClass: z.enum(["cheap", "normal", "expensive"])
  }),
  doneDefinition: z.array(z.string())
});

export const resultPacketSchema = z.object({
  taskId: z.string(),
  status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  artifacts: z.array(z.string()),
  testsRun: z.array(z.string()),
  risks: z.array(z.string()),
  followups: z.array(z.string()),
  scriptizationCandidates: z.array(z.string()),
  blockers: z.array(z.string())
});

export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type ExecutionPacket = z.infer<typeof executionPacketSchema>;
export type ResultPacket = z.infer<typeof resultPacketSchema>;

export interface StartCoderRunInput {
  taskId: string;
  mode: CoderRuntimeMode;
  executionPacket: ExecutionPacket;
  secretsEnv?: Record<string, string>;
}

export interface RunHandle {
  runId: string;
}

export interface CoderEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CoderResult {
  runId: string;
  status: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  changedFiles: string[];
  diff: string | null;
  artifacts: Array<{ type: string; ref: string }>;
  testsRun: string[];
  risks: string[];
  followups: string[];
  scriptizationCandidates: string[];
  blockers: string[];
}

export interface CoderRuntime {
  startRun(input: StartCoderRunInput): Promise<RunHandle>;
  streamEvents(runId: string): AsyncIterable<CoderEvent>;
  cancelRun(runId: string): Promise<void>;
  getResult(runId: string): Promise<CoderResult>;
}

export interface CandidateMemory {
  scopeType: MemoryScopeType;
  memoryType: string;
  content: string;
  confidence: number;
  importance: number;
}

export interface FrontdeskClassification {
  classification: MessageClassification;
  replyMode: ReplyMode;
  scope: MemoryScopeType;
  entities: Record<string, unknown>;
  candidateMemories: CandidateMemory[];
  taskBrief: string | null;
  autoReply: string | null;
}

export interface RetrievalTraceEntry {
  source: string;
  reason: string;
  memoryItemId?: string;
  rawEventId?: string;
  score?: number;
}

export interface BundleSection {
  name: string;
  content: string;
  source: string;
  tokens: number;
}

export interface ContextBundle {
  sections: BundleSection[];
  retrievalTrace: RetrievalTraceEntry[];
  totalTokens: number;
}

export interface SecretReference {
  id: string;
  serviceName: string;
  key: string;
  description: string | null;
}

export interface BuildBundleInput {
  userId: string;
  taskBrief: string;
  scopeType: MemoryScopeType;
  scopeId?: string;
  maxTokens?: number;
}

export interface MemoryItem {
  id: string;
  scopeType: MemoryScopeType;
  scopeId?: string | null;
  memoryType: string;
  content: string;
  summary?: string | null;
  sourceEventIds: string[];
  confidence: number;
  importance: number;
  status: MemoryStatus;
  ttlPolicy?: string | null;
  supersedesId?: string | null;
  conflictsWith: string[];
  evidenceRefs: string[];
  embedding: number[];
  userId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryQuery {
  userId?: string;
  scopeType?: MemoryScopeType;
  scopeId?: string;
  status?: MemoryStatus;
  searchText?: string;
  taskId?: string;
  projectId?: string;
  limit?: number;
}

export interface ConsolidateOptions {
  olderThanMinutes?: number;
  now?: string;
}

export interface ConsolidationResult {
  scanned: number;
  promoted: number;
  superseded: number;
  forgotten: number;
}

export const supervisorUsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  model: z.string()
});

export type SupervisorUsage = z.infer<typeof supervisorUsageSchema>;

export const verifierVerdictSchema = z.object({
  verdict: z.enum(["pass", "revise", "fail"]),
  reason: z.string(),
  risks: z.array(z.string()),
  missingChecks: z.array(z.string()),
  usage: supervisorUsageSchema.optional()
});

export type VerifierVerdict = z.infer<typeof verifierVerdictSchema>;

export const supervisorPlanSchema = z.object({
  steps: z.array(planStepSchema),
  estimatedCost: z.number(),
  routingProfile: z.enum(["cheap_first", "balanced", "quality_first", "latency_first"]),
  approvalRequired: z.boolean(),
  routeDecision: routeDecisionSchema,
  directAnswer: z.string().nullable().optional(),
  usage: supervisorUsageSchema.optional()
});

export type SupervisorPlan = z.infer<typeof supervisorPlanSchema>;

export const supervisorSynthesisSchema = z.object({
  summary: z.string(),
  artifacts: z.array(subagentArtifactSchema),
  verdict: verifierVerdictSchema.shape.verdict,
  scriptizationCandidates: z.array(z.string()),
  proposedPolicyPatch: policyPatchSchema.optional(),
  usage: supervisorUsageSchema.optional()
});

export type SupervisorSynthesis = z.infer<typeof supervisorSynthesisSchema>;

export interface SupervisorRuntime {
  plan(task: Task, context: Record<string, unknown>): Promise<SupervisorPlan>;
  synthesize(
    task: Task,
    subagentResults: SubagentResult[],
    context?: Record<string, unknown>
  ): Promise<SupervisorSynthesis>;
  verify(task: Task, coderResult: CoderResult, context?: Record<string, unknown>): Promise<VerifierVerdict>;
}
