import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoderEvent,
  CoderResult,
  CoderRuntime,
  resultPacketSchema,
  RunHandle,
  StartCoderRunInput
} from "@agent-platform/contracts";

interface CodexCliRuntimeOptions {
  command?: string;
  timeoutMs?: number;
  cwd?: string;
}

interface RunningCodexRun {
  abortController: AbortController;
  events: CoderEvent[];
  resultPromise: Promise<CoderResult>;
}

interface CodexCliJsonResult {
  summary?: unknown;
  diff?: unknown;
  changedFiles?: unknown;
  artifacts?: unknown;
}

export class CodexCliRuntime implements CoderRuntime {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly cwd?: string;
  private readonly developerPrompt: string;
  private readonly runs = new Map<string, RunningCodexRun>();

  constructor(options: CodexCliRuntimeOptions = {}) {
    this.command = options.command ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.cwd = options.cwd;
    this.developerPrompt = loadPromptAsset(
      process.env.CODEX_DEVELOPER_PROMPT_PATH,
      "../../../docs/prompts/codex-developer-v0.1.md",
      "codex-developer-v0.1.md"
    );
  }

  async startRun(input: StartCoderRunInput): Promise<RunHandle> {
    const runId = `codex_${input.taskId}_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const abortController = new AbortController();
    const events: CoderEvent[] = [
      {
        type: "codex.run.started",
        createdAt,
        payload: { runId, mode: input.mode }
      }
    ];

    const resultPromise = this.executeRun(runId, input, abortController)
      .then((result) => {
        events.push({
          type: `codex.run.${result.status}`,
          createdAt: new Date().toISOString(),
          payload: { runId, changedFiles: result.changedFiles }
        });
        return result;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown Codex CLI failure";
        events.push({
          type: "codex.run.failed",
          createdAt: new Date().toISOString(),
          payload: { runId, error: message }
        });
        return {
          runId,
          status: "failed",
          summary: message,
          changedFiles: [],
          diff: null,
          artifacts: [],
          testsRun: [],
          risks: ["Codex CLI execution failed."],
          followups: [],
          scriptizationCandidates: [],
          blockers: [message]
        } satisfies CoderResult;
      });

    this.runs.set(runId, {
      abortController,
      events,
      resultPromise
    });

    return { runId };
  }

  async *streamEvents(runId: string): AsyncIterable<CoderEvent> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown Codex run ${runId}`);
    }

    for (const event of run.events) {
      yield event;
    }

    const result = await run.resultPromise;
    const lastEvent = run.events.at(-1);
    if (!lastEvent || lastEvent.type !== `codex.run.${result.status}`) {
      yield {
        type: `codex.run.${result.status}`,
        createdAt: new Date().toISOString(),
        payload: { runId, changedFiles: result.changedFiles }
      };
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    run.abortController.abort();
    run.events.push({
      type: "codex.run.cancelled",
      createdAt: new Date().toISOString(),
      payload: { runId }
    });
  }

  async getResult(runId: string): Promise<CoderResult> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown Codex run ${runId}`);
    }

    return run.resultPromise;
  }

  private async executeRun(
    runId: string,
    input: StartCoderRunInput,
    abortController: AbortController
  ): Promise<CoderResult> {
    const prompt = [
      this.developerPrompt,
      "You are the Codex CLI runtime for an adaptive orchestrator.",
      "Return JSON only as a result_packet.",
      `Mode: ${input.mode}`,
      "execution_packet:",
      JSON.stringify(input.executionPacket, null, 2)
    ].join("\n");

    const stdout = await execFileJson(this.command, ["exec", "--full-auto", prompt], {
      cwd: this.cwd,
      timeout: this.timeoutMs,
      signal: abortController.signal,
      env: {
        ...process.env,
        ...(input.secretsEnv ?? {})
      }
    });

    const parsed = parseCodexResult(stdout);

    return {
      runId,
      status: parsed.status,
      summary: parsed.summary,
      diff: parsed.diff,
      changedFiles: parsed.changedFiles,
      artifacts: parsed.artifacts,
      testsRun: parsed.testsRun,
      risks: parsed.risks,
      followups: parsed.followups,
      scriptizationCandidates: parsed.scriptizationCandidates,
      blockers: parsed.blockers
    };
  }
}

function parseCodexResult(rawOutput: string) {
  const normalizedPacket = extractResultPacket(rawOutput);
  if (normalizedPacket) {
    return {
      status: normalizedPacket.status,
      summary: normalizedPacket.summary,
      diff: null,
      changedFiles: normalizedPacket.filesChanged,
      artifacts: normalizedPacket.artifacts.map((artifact) => ({ type: "note", ref: artifact })),
      testsRun: normalizedPacket.testsRun,
      risks: normalizedPacket.risks,
      followups: normalizedPacket.followups,
      scriptizationCandidates: normalizedPacket.scriptizationCandidates,
      blockers: normalizedPacket.blockers
    };
  }

  const parsed = safeJsonParse<CodexCliJsonResult>(rawOutput);

  if (!parsed) {
    return {
      status: "completed" as const,
      summary: rawOutput.trim() || "Codex CLI completed without structured output.",
      diff: null,
      changedFiles: [] as string[],
      artifacts: [] as Array<{ type: string; ref: string }>,
      testsRun: [] as string[],
      risks: ["Codex CLI response did not match result_packet schema."],
      followups: [] as string[],
      scriptizationCandidates: [] as string[],
      blockers: [] as string[]
    };
  }

  return {
    status: "completed" as const,
    summary: typeof parsed.summary === "string" ? parsed.summary : "Codex CLI completed.",
    diff: typeof parsed.diff === "string" ? parsed.diff : null,
    changedFiles: Array.isArray(parsed.changedFiles)
      ? parsed.changedFiles.filter((item): item is string => typeof item === "string")
      : [],
    artifacts: Array.isArray(parsed.artifacts)
      ? parsed.artifacts.flatMap((item) => {
          if (
            item &&
            typeof item === "object" &&
            "type" in item &&
            "ref" in item &&
            typeof item.type === "string" &&
            typeof item.ref === "string"
          ) {
            return [{ type: item.type, ref: item.ref }];
          }
          return [];
        })
      : [],
    testsRun: [],
    risks: [],
    followups: [],
    scriptizationCandidates: [],
    blockers: []
  };
}

function extractResultPacket(rawOutput: string) {
  const direct = resultPacketSchema.safeParse(safeJsonParse(rawOutput));
  if (direct.success) {
    return direct.data;
  }

  const jsonMatch = rawOutput.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    return null;
  }

  const parsed = resultPacketSchema.safeParse(safeJsonParse(jsonMatch[0]));
  return parsed.success ? parsed.data : null;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function execFileJson(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    timeout: number;
    signal: AbortSignal;
    env?: NodeJS.ProcessEnv;
  }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        signal: options.signal,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
          reject(new Error(`Codex CLI execution failed${suffix}`));
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

function loadPromptAsset(configuredPath: string | undefined, defaultRelativeFile: string, expectedFileName: string): string {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(baseDir, defaultRelativeFile);
  const promptPath = resolvePromptFilePath(configuredPath, defaultPath, expectedFileName);
  if (!existsSync(promptPath)) {
    return "";
  }

  try {
    return readFileSync(promptPath, "utf8").trim();
  } catch {
    return "";
  }
}

function resolvePromptFilePath(
  configuredPath: string | undefined,
  defaultPath: string,
  expectedFileName: string
): string {
  if (!configuredPath || configuredPath.trim().length === 0) {
    return defaultPath;
  }

  const resolved = resolve(configuredPath);
  if (resolved.endsWith(".md")) {
    return resolved;
  }

  return resolve(resolved, expectedFileName);
}
