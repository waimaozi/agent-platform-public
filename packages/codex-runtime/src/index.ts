import {
  CoderEvent,
  CoderResult,
  CoderRuntime,
  RunHandle,
  StartCoderRunInput
} from "@agent-platform/contracts";
export * from "./codex-cli-runtime.js";

export class MockCodexRuntime implements CoderRuntime {
  private readonly runs = new Map<string, CoderResult>();

  async startRun(input: StartCoderRunInput): Promise<RunHandle> {
    const runId = `codex_${input.taskId}`;
    this.runs.set(runId, {
      runId,
      status: "completed",
      summary: `Mock Codex run completed in ${input.mode}`,
      changedFiles: ["README.md"],
      diff: "--- a/README.md\n+++ b/README.md\n@@\n-Mock\n+Mock Codex change\n",
      artifacts: [{ type: "diff", ref: `${runId}.diff` }],
      testsRun: ["pnpm test"],
      risks: [],
      followups: ["Capture repeated mock edit patterns as a fixture."],
      scriptizationCandidates: ["Convert fixed mock coder responses into reusable fixtures."],
      blockers: []
    });
    return { runId };
  }

  async *streamEvents(runId: string): AsyncIterable<CoderEvent> {
    yield {
      type: "codex.run.started",
      createdAt: new Date().toISOString(),
      payload: { runId }
    };
    yield {
      type: "codex.run.completed",
      createdAt: new Date().toISOString(),
      payload: { runId }
    };
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = "cancelled";
    }
  }

  async getResult(runId: string): Promise<CoderResult> {
    const result = this.runs.get(runId);
    if (!result) {
      throw new Error(`Unknown Codex run ${runId}`);
    }
    return result;
  }
}
