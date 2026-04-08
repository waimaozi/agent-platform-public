import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoderResult,
  routeDecisionSchema,
  SubagentResult,
  SupervisorPlan,
  SupervisorRuntime,
  SupervisorSynthesis,
  SupervisorUsage,
  Task,
  VerifierVerdict
} from "@agent-platform/contracts";

interface ClaudeCodeSupervisorRuntimeOptions {
  command?: string;
  timeoutMs?: number;
  cwd?: string;
}

const FALLBACK_SYSTEM_PROMPT = [
  "You are the supervisor runtime for the adaptive orchestrator.",
  "Prefer the cheapest safe path.",
  "Use answer_self for any read-only or explanatory task.",
  "Use codex only when the user explicitly asks to create or edit code.",
  "Return concise, valid JSON when asked."
].join("\n");

const DEFAULT_SYSTEM_PROMPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/prompts/opus-system-v0.1.md"
);

export class MockSupervisorRuntime implements SupervisorRuntime {
  async plan(task: Task): Promise<SupervisorPlan> {
    return {
      steps: [
        {
          id: `${task.id}:research`,
          title: "Research task intent",
          description: "Summarize the request and identify delivery constraints.",
          subagent: "researcher",
          acceptanceCriteria: ["Scope clarified", "Risks identified"]
        },
        {
          id: `${task.id}:code`,
          title: "Implement requested change",
          description: "Run the coder against the prepared brief.",
          subagent: "coder",
          acceptanceCriteria: ["Code updated", "Artifacts attached"]
        },
        {
          id: `${task.id}:verify`,
          title: "Verify result",
          description: "Review the coder output and decide whether to accept it.",
          subagent: "verifier",
          acceptanceCriteria: ["Verdict recorded", "Follow-up checks listed"]
        }
      ],
      estimatedCost: 0.09,
      routingProfile: task.routingProfile,
      approvalRequired: false,
      routeDecision: buildMockRouteDecision(task),
      directAnswer: null
    };
  }

  async synthesize(
    task: Task,
    subagentResults: SubagentResult[],
    _context?: Record<string, unknown>
  ): Promise<SupervisorSynthesis> {
    const artifacts = subagentResults.flatMap((result) => result.artifacts);
    return {
      summary: `Mock supervisor synthesized ${subagentResults.length} subagent result(s) for task ${task.id}.`,
      artifacts,
      verdict: "pass",
      scriptizationCandidates: ["Convert repeated research briefing into a deterministic task summarizer."]
    };
  }

  async verify(task: Task, coderResult: CoderResult, _context?: Record<string, unknown>): Promise<VerifierVerdict> {
    return {
      verdict: coderResult.status === "completed" ? "pass" : "revise",
      reason:
        coderResult.status === "completed"
          ? `Mock verifier accepted the coder output for task ${task.id}.`
          : "Coder result did not complete successfully.",
      risks: coderResult.status === "completed" ? ["Repository checks are mocked in this slice."] : ["Execution failed."],
      missingChecks: ["No CLI test or lint command was executed by the mock verifier."]
    };
  }
}

export class ClaudeCodeSupervisorRuntime implements SupervisorRuntime {
  private static systemPromptCache = new Map<string, string>();

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly cwd?: string;
  private readonly opusSystemPromptPath: string;
  private systemPromptText?: string;

  constructor(options: ClaudeCodeSupervisorRuntimeOptions = {}) {
    this.command = options.command ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 1000;
    this.cwd = options.cwd;
    this.opusSystemPromptPath = resolve(process.env.OPUS_SYSTEM_PROMPT_PATH ?? DEFAULT_SYSTEM_PROMPT_PATH);
  }

  async plan(task: Task, context: Record<string, unknown>): Promise<SupervisorPlan> {
    const prompt = [
      "Return JSON only.",
      "The JSON must contain: plan, routeDecision, directAnswer, estimatedCost.",
      "If executionType is answer_self, directAnswer MUST contain the FULL answer.",
      "ROUTING RULES (STRICT):",
      "answer_self — for ANY question answerable from context/files/knowledge",
      "answer_self — USE THIS for:",
      "- ANY question that can be answered from context, files, or knowledge",
      '- "Read file X", "what\'s in X", "summarize X", "analyze X"',
      '- "List projects", "what projects", "show status"',
      '- "Explain X", "what is X", "how does X work"',
      '- "What did we do", "what happened", "what\'s the status"',
      '- Self-reflection: "what tools do you have", "what can you do"',
      '- Opinions: "what do you think about X"',
      "- ANY request that does NOT require creating/editing files in a repository",
      "codex — ONLY for explicit code creation/editing requests",
      "codex — USE THIS ONLY for:",
      '- Explicit requests to CREATE or EDIT code files',
      '- "Add function X", "fix bug in Y", "update file Z"',
      '- "Write a script", "create a new endpoint", "refactor module"',
      '- Tasks where the deliverable is a CODE CHANGE (diff, new file, PR)',
      "workflow — USE THIS for:",
      "- Sending email via SMTP",
      "- Reading inbox or calendar data via n8n webhooks",
      "human_approval — for dangerous operations",
      "human_approval — USE THIS for:",
      "- Dangerous operations (delete, deploy, infra changes)",
      "DEFAULT: answer_self",
      "DEFAULT: If unsure, use answer_self. It's always safer and cheaper.",
      `Task JSON: ${JSON.stringify(task)}`,
      `Context: ${JSON.stringify(context ?? {})}`
    ].join("\n");

    try {
      const { result, usage } = await this.callClaude(prompt);
      const parsed = extractJsonValue(result);
      const plan = parsePlan(parsed, task);
      if (usage) {
        plan.usage = usage;
      }
      return plan;
    } catch {
      return defaultPlan(task);
    }
  }

  async synthesize(
    task: Task,
    subagentResults: SubagentResult[],
    context?: Record<string, unknown>
  ): Promise<SupervisorSynthesis> {
    const instruction = typeof context?.instruction === "string" ? context.instruction : null;

    if (instruction) {
      try {
        const prompt = [
          instruction,
          "Answer directly. Do not return JSON.",
          "Use Russian if the user asked in Russian.",
          context?.contextBundle ? `Context bundle: ${JSON.stringify(context.contextBundle)}` : ""
        ]
          .filter(Boolean)
          .join("\n");

        const { result, usage } = await this.callClaude(prompt);
        const synthesis = parseSynthesis(
          {
            summary: result.trim(),
            artifacts: [],
            verdict: "pass",
            scriptizationCandidates: []
          },
          task,
          subagentResults
        );
        if (usage) {
          synthesis.usage = usage;
        }
        return synthesis;
      } catch {
        return parseSynthesis(null, task, subagentResults);
      }
    }

    const prompt = [
      "Return JSON only.",
      "The JSON must contain a top-level `synthesis` object.",
      "The `synthesis` object must contain: summary, artifacts, verdict, scriptizationCandidates, proposedPolicyPatch.",
      "The summary must be the full user-facing answer, not a meta description.",
      `Task JSON: ${JSON.stringify(task)}`,
      `Subagent results: ${JSON.stringify(subagentResults)}`,
      context?.contextBundle ? `Context bundle: ${JSON.stringify(context.contextBundle)}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const { result, usage } = await this.callClaude(prompt);
      const parsed = extractJsonValue(result);
      const synthesis = parseSynthesis(parsed, task, subagentResults);
      if (usage) {
        synthesis.usage = usage;
      }
      return synthesis;
    } catch {
      return parseSynthesis(null, task, subagentResults);
    }
  }

  async verify(task: Task, coderResult: CoderResult, _context?: Record<string, unknown>): Promise<VerifierVerdict> {
    const taskSnippet = truncate(JSON.stringify({
      id: task.id,
      title: task.title,
      normalizedInput: task.normalizedInput
    }), 500);
    const coderSnippet = truncate(JSON.stringify({
      status: coderResult.status,
      summary: coderResult.summary,
      changedFiles: coderResult.changedFiles
    }), 500);

    const prompt = [
      "Return JSON only.",
      "The JSON must contain a top-level `verdict` object.",
      "The `verdict` object must contain: verdict, reason, risks, missingChecks.",
      `Task: ${taskSnippet}`,
      `Coder summary: ${coderSnippet}`
    ].join("\n");

    try {
      const { result, usage } = await this.callClaude(prompt);
      const parsed = extractJsonValue(result);
      const verdict = parseVerdict(parsed, task, coderResult);
      if (usage) {
        verdict.usage = usage;
      }
      return verdict;
    } catch {
      return parseVerdict(null, task, coderResult);
    }
  }

  private async callClaude(prompt: string): Promise<{ result: string; usage?: SupervisorUsage }> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/home/openclaw/mira-soul",
      "--add-dir",
      "/home/openclaw/.openclaw/workspace"
    ];

    if (this.isReadableFile(this.opusSystemPromptPath)) {
      args.push("--system-prompt-file", this.opusSystemPromptPath);
    } else {
      prompt = `${this.getSystemPromptText()}\n\n${prompt}`;
      args[1] = prompt;
    }

    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.command, args, {
        cwd: this.cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const resolveOnce = (value: { result: string; usage?: SupervisorUsage }) => {
        if (!settled) {
          settled = true;
          resolvePromise(value);
        }
      };

      const rejectOnce = (error: Error) => {
        if (!settled) {
          settled = true;
          rejectPromise(error);
        }
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        rejectOnce(new Error(`Claude CLI spawn failed: ${error.message}`));
      });

      child.on("close", (code, signal) => {
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();

        if (signal && signal !== "SIGTERM") {
          rejectOnce(new Error(`Claude CLI terminated with signal ${signal}${trimmedStderr ? `: ${trimmedStderr}` : ""}`));
          return;
        }

        if (trimmedStdout.startsWith("{")) {
          const envelope = safeJsonParse<Record<string, unknown>>(trimmedStdout);
          if (!envelope) {
            rejectOnce(new Error("Claude CLI returned invalid JSON output"));
            return;
          }

          const usage = parseEnvelopeUsage(envelope);
          const extractedText =
            typeof envelope.result === "string"
              ? envelope.result
              : asRecord(envelope.structured_output)
                ? JSON.stringify(envelope.structured_output)
                : trimmedStdout;

          resolveOnce({ result: extractedText, usage });
          return;
        }

        if (trimmedStdout.length === 0 || code !== 0) {
          rejectOnce(new Error(trimmedStderr || `Claude CLI exited with code ${code ?? "unknown"}`));
          return;
        }

        resolveOnce({ result: trimmedStdout });
      });
    });
  }

  private getSystemPromptText(): string {
    if (this.systemPromptText) {
      return this.systemPromptText;
    }

    const cached = ClaudeCodeSupervisorRuntime.systemPromptCache.get(this.opusSystemPromptPath);
    if (cached) {
      this.systemPromptText = cached;
      return cached;
    }

    const value = this.readSystemPromptFromDisk() ?? FALLBACK_SYSTEM_PROMPT;
    ClaudeCodeSupervisorRuntime.systemPromptCache.set(this.opusSystemPromptPath, value);
    this.systemPromptText = value;
    return value;
  }

  private readSystemPromptFromDisk(): string | null {
    try {
      accessSync(this.opusSystemPromptPath, constants.R_OK);
      const text = readFileSync(this.opusSystemPromptPath, "utf8").trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  private isReadableFile(path: string): boolean {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function parseEnvelopeUsage(envelope: Record<string, unknown>): SupervisorUsage | undefined {
  const modelUsage = envelope.modelUsage;
  if (Array.isArray(modelUsage)) {
    for (const item of modelUsage) {
      const usage = parseUsageRecord(asRecord(item), toNumber(envelope.total_cost_usd));
      if (usage) {
        return usage;
      }
    }
  }

  const usageFromModelUsage = parseUsageRecord(asRecord(modelUsage), toNumber(envelope.total_cost_usd));
  if (usageFromModelUsage) {
    return usageFromModelUsage;
  }

  return parseUsageRecord(asRecord(envelope.usage), toNumber(envelope.total_cost_usd), envelope.model);
}

function parsePlan(value: unknown, task: Task): SupervisorPlan {
  const record = asRecord(value);
  if (!record) {
    return defaultPlan(task);
  }

  const planRecord = asRecord(record.plan) ?? record;
  const routeDecision = parseRouteDecision(record.routeDecision ?? record.route_decision ?? planRecord.routeDecision, task);

  return {
    steps: Array.isArray(planRecord.steps)
      ? planRecord.steps.flatMap((step, index) => {
          const candidate = asRecord(step);
          if (!candidate) {
            return [];
          }

          return [
            {
              id: typeof candidate.id === "string" ? candidate.id : `${task.id}:step:${index + 1}`,
              title: typeof candidate.title === "string" ? candidate.title : `Step ${index + 1}`,
              description:
                typeof candidate.description === "string" ? candidate.description : "No description provided.",
              subagent: normalizeSubagent(candidate.subagent),
              acceptanceCriteria: readStringArray(candidate.acceptanceCriteria)
            }
          ];
        })
      : [],
    estimatedCost: toNumber(planRecord.estimatedCost ?? record.estimatedCost) ?? 0,
    routingProfile: normalizeRoutingProfile(planRecord.routingProfile ?? record.routingProfile, task.routingProfile),
    approvalRequired: Boolean(planRecord.approvalRequired ?? record.approvalRequired ?? false),
    routeDecision,
    directAnswer: normalizeDirectAnswer(planRecord.directAnswer ?? record.directAnswer)
  };
}

function parseSynthesis(value: unknown, task: Task, results: SubagentResult[]): SupervisorSynthesis {
  const record = asRecord(value);
  const synthesis = record ? asRecord(record.synthesis) ?? record : null;
  const fallbackArtifacts = results.flatMap((result) => result.artifacts);

  if (!synthesis) {
    return {
      summary: `Synthesis unavailable for task ${task.id}.`,
      artifacts: fallbackArtifacts,
      verdict: "revise",
      scriptizationCandidates: []
    };
  }

  return {
    summary: typeof synthesis.summary === "string" ? synthesis.summary : `Synthesis unavailable for task ${task.id}.`,
    artifacts: normalizeArtifacts(synthesis.artifacts, fallbackArtifacts),
    verdict: normalizeVerdictValue(synthesis.verdict),
    scriptizationCandidates: readStringArray(
      synthesis.scriptizationCandidates ?? synthesis.scriptization_candidates
    ),
    proposedPolicyPatch:
      synthesis.proposedPolicyPatch && typeof synthesis.proposedPolicyPatch === "object"
        ? (synthesis.proposedPolicyPatch as SupervisorSynthesis["proposedPolicyPatch"])
        : undefined
  };
}

function parseVerdict(value: unknown, task: Task, coderResult: CoderResult): VerifierVerdict {
  const record = asRecord(value);
  const verdict = record ? asRecord(record.verdict) ?? record : null;

  if (!verdict) {
    return {
      verdict: "revise",
      reason: `Verification unavailable for task ${task.id}.`,
      risks: ["Claude supervisor runtime did not produce a structured verifier verdict."],
      missingChecks: ["Structured verifier output missing."]
    };
  }

  return {
    verdict: normalizeVerdictValue(verdict.verdict),
    reason:
      typeof verdict.reason === "string"
        ? verdict.reason
        : `Verification unavailable for task ${task.id}; coder status was ${coderResult.status}.`,
    risks: readStringArray(verdict.risks),
    missingChecks: readStringArray(verdict.missingChecks ?? verdict.missing_checks)
  };
}

function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  const direct = safeJsonParse<unknown>(trimmed);
  if (direct !== null) {
    return direct;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  return safeJsonParse<unknown>(match[0]);
}

function parseUsageRecord(
  value: Record<string, unknown> | null,
  fallbackCost: number | null,
  fallbackModel?: unknown
): SupervisorUsage | undefined {
  if (!value) {
    return undefined;
  }

  const inputTokens = toNumber(
    value.inputTokens ?? value.input_tokens ?? value.promptTokens ?? value.prompt_tokens
  );
  const outputTokens = toNumber(
    value.outputTokens ?? value.output_tokens ?? value.completionTokens ?? value.completion_tokens
  );
  const costUsd = toNumber(value.costUsd ?? value.cost_usd ?? value.totalCostUsd ?? value.total_cost_usd) ?? fallbackCost;
  const model = normalizeModel(value.model ?? fallbackModel);

  if (inputTokens === null || outputTokens === null || costUsd === null) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    costUsd,
    model
  };
}

function normalizeRoutingProfile(
  value: unknown,
  fallback: Task["routingProfile"]
): Task["routingProfile"] {
  return value === "cheap_first" || value === "balanced" || value === "quality_first" || value === "latency_first"
    ? value
    : fallback;
}

function normalizeDirectAnswer(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  return value === null ? null : null;
}

function normalizeArtifacts(
  value: unknown,
  fallback: SupervisorSynthesis["artifacts"]
): SupervisorSynthesis["artifacts"] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value.flatMap((item) => {
    const artifact = asRecord(item);
    const type = normalizeArtifactType(artifact?.type);
    if (!type || !artifact || typeof artifact.ref !== "string") {
      return [];
    }

    return [{ type, ref: artifact.ref }];
  });
}

function normalizeVerdictValue(value: unknown): "pass" | "revise" | "fail" {
  return value === "pass" || value === "revise" || value === "fail" ? value : "revise";
}

function normalizeSubagent(value: unknown): "researcher" | "coder" | "verifier" | "supervisor" {
  return value === "researcher" || value === "coder" || value === "verifier" || value === "supervisor"
    ? value
    : "supervisor";
}

function normalizeArtifactType(
  value: unknown
): SupervisorSynthesis["artifacts"][number]["type"] | null {
  return value === "diff" ||
    value === "log" ||
    value === "test_report" ||
    value === "note" ||
    value === "branch" ||
    value === "pr" ||
    value === "file"
    ? value
    : null;
}

function parseRouteDecision(value: unknown, task: Task): SupervisorPlan["routeDecision"] {
  const record = asRecord(value);
  const normalized = record
    ? {
        goal: record.goal,
        scope: record.scope,
        executionType: record.executionType ?? record.execution_type,
        capabilityId: record.capabilityId ?? record.capability_id ?? null,
        whyThisPath: record.whyThisPath ?? record.why_this_path,
        whyNotCheaperPath: record.whyNotCheaperPath ?? record.why_not_cheaper_path,
        risk: record.risk,
        budgetClass: record.budgetClass ?? record.budget_class,
        expectedArtifacts: record.expectedArtifacts ?? record.expected_artifacts,
        fallback: record.fallback
      }
    : value;

  const parsed = routeDecisionSchema.safeParse(normalized);
  return parsed.success ? parsed.data : buildAnswerSelfRouteDecision(task);
}

function defaultPlan(task: Task): SupervisorPlan {
  return {
    steps: [],
    estimatedCost: 0,
    routingProfile: task.routingProfile,
    approvalRequired: false,
    routeDecision: buildAnswerSelfRouteDecision(task),
    directAnswer: null
  };
}

function buildMockRouteDecision(task: Task): SupervisorPlan["routeDecision"] {
  return {
    goal: task.title,
    scope: "task",
    executionType: "codex",
    capabilityId: null,
    whyThisPath: "Task requires repository changes and validation.",
    whyNotCheaperPath: "A deterministic workflow is not encoded for this request.",
    risk: "medium",
    budgetClass: task.routingProfile === "cheap_first" ? "cheap" : "normal",
    expectedArtifacts: ["summary", "diff", "tests"],
    fallback: "Escalate for approval or human review if implementation blocks."
  };
}

function buildAnswerSelfRouteDecision(task: Task): SupervisorPlan["routeDecision"] {
  return {
    goal: task.title,
    scope: "task",
    executionType: "answer_self",
    capabilityId: null,
    whyThisPath: "Default safe fallback is to answer directly.",
    whyNotCheaperPath: "This is already the cheapest path.",
    risk: "low",
    budgetClass: "cheap",
    expectedArtifacts: ["answer"],
    fallback: "Escalate to codex or approval only if edits or dangerous actions are required."
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeModel(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return "claude";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
