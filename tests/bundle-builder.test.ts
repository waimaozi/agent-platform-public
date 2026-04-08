import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrismaBundleBuilder } from "@agent-platform/bundle-builder";

describe("PrismaBundleBuilder", () => {
  it("assembles bundle sections in deterministic order", async () => {
    const builder = new PrismaBundleBuilder(createBundleDb() as never);
    const bundle = await builder.build({
      userId: "user-1",
      taskBrief: "Investigate the deploy issue",
      scopeType: "project",
      scopeId: "project-1",
      maxTokens: 10000
    });

    expect(bundle.sections.map((section) => section.name)).toEqual([
      "policy/system",
      "available services",
      "n8n workflows",
      "project card",
      "pinned facts",
      "user triggers",
      "financial context",
      "task brief",
      "structured memories"
    ]);
    expect(bundle.totalTokens).toBeGreaterThan(0);
    expect(bundle.retrievalTrace.some((entry) => entry.reason === "Pinned durable fact")).toBe(true);
  });

  it("loads SOUL.md from the configured file path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "bundle-builder-"));
    const soulPath = join(tempDir, "SOUL.md");

    try {
      await writeFile(soulPath, "You are Agent from SOUL.md.\nProtect scoped memory.", "utf8");

      const builder = new PrismaBundleBuilder(createBundleDb() as never, { soulPath });
      const bundle = await builder.build({
        userId: "user-1",
        taskBrief: "Investigate the deploy issue",
        scopeType: "task",
        scopeId: "thread-1",
        maxTokens: 1000
      });

      expect(bundle.sections[0]?.name).toBe("policy/system");
      expect(bundle.sections[0]?.content).toContain("You are Agent from SOUL.md.");
      expect(bundle.sections[0]?.source).toBe(soulPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes available service names without secret values", async () => {
    const builder = new PrismaBundleBuilder(createBundleDb() as never, {
      secretsService: {
        listServices: async () => [
          { serviceName: "github", keyCount: 2, scope: "global" },
          { serviceName: "n8n", keyCount: 1, scope: "global" },
          { serviceName: "github", keyCount: 1, scope: "project" }
        ]
      }
    });

    const bundle = await builder.build({
      userId: "user-1",
      taskBrief: "Investigate the deploy issue",
      scopeType: "project",
      scopeId: "project-1",
      maxTokens: 10000
    });

    const servicesSection = bundle.sections.find((section) => section.name === "available services");
    const workflowsSection = bundle.sections.find((section) => section.name === "n8n workflows");
    expect(servicesSection?.content).toContain("- email (SMTP send via test@example.com)");
    expect(servicesSection?.content).toContain("- calendar (via n8n webhook, not yet configured)");
    expect(servicesSection?.content).toContain("- github");
    expect(servicesSection?.content).toContain("- n8n");
    expect(servicesSection?.content).not.toContain("TOKEN");
    expect(workflowsSection?.content).toContain("N8N Workflows (active):");
    expect(workflowsSection?.content).toContain("- ExampleCorp Mail Agent (send emails from ExampleCorp addresses)");
    expect(workflowsSection?.content).toContain("- Agent CRM Lead Capture (capture leads)");
    expect(workflowsSection?.content).toContain("- ExampleCorp SGR Bot (answer chemistry product questions)");
    expect(workflowsSection?.content).toContain("- ExampleProject Lead Form (process ExampleProject leads)");
  });
});

function createBundleDb() {
  return {
    projectProfile: {
      findUnique: async () => ({
        id: "project-1",
        name: "Agent Platform",
        status: "active",
        deadline: new Date("2026-04-10T00:00:00.000Z"),
        priority: "high",
        blockers: ["Waiting for review"],
        lastActivityAt: new Date("2026-04-07T10:00:00.000Z"),
        notes: "Keep webhook stable",
        repoUrl: "https://github.com/example/agent-platform",
        packageManager: "pnpm",
        buildCommand: "pnpm build",
        testCommand: "pnpm test",
        lintCommand: "pnpm lint",
        typecheckCommand: "pnpm lint",
        branchPolicy: "trunk",
        prStyle: "small",
        knownPitfalls: ["Do not break Telegram webhook"]
      })
    },
    memoryItem: {
      findMany: async ({ where }: { where: Record<string, any> }) => {
        if (where.scopeType === "pinned") {
          if (where.memoryType === "financial_context") {
            return [
              {
                id: "memory-finance",
                content: "Budget is capped at $500/month",
                importance: 0.9,
                updatedAt: new Date()
              }
            ];
          }
          return [
            {
              id: "memory-pin",
              content: "Budget caps matter",
              importance: 1,
              updatedAt: new Date()
            }
          ];
        }

        if (where.scopeType === "user_profile") {
          return [
            {
              id: "memory-trigger",
              content: "Long ambiguous asks increase context switching",
              importance: 0.95,
              updatedAt: new Date()
            }
          ];
        }

        return [
          {
            id: "memory-structured",
            content: "Project uses Prisma for state persistence",
            memoryType: "fact",
            importance: 0.8,
            updatedAt: new Date()
          }
        ];
      }
    },
    rawEvent: {
      findMany: async () => []
    }
  };
}
