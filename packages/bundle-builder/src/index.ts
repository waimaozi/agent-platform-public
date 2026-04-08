import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import {
  BuildBundleInput,
  BundleSection,
  ContextBundle,
  MemoryScopeType,
  RetrievalTraceEntry
} from "@agent-platform/contracts";
import { prisma } from "@agent-platform/core";
import { getActiveN8nWorkflows, getN8nWorkflowBundleDescription } from "@agent-platform/integrations";
import { SecretsService } from "@agent-platform/secrets-service";

export interface BundleBuilder {
  build(input: BuildBundleInput): Promise<ContextBundle>;
}

export interface PrismaBundleBuilderOptions {
  soulPath?: string;
  secretsService?: Pick<SecretsService, "listServices">;
}

export class PrismaBundleBuilder implements BundleBuilder {
  private static soulCache = new Map<string, string>();
  private readonly soulPath: string;
  private readonly secretsService?: Pick<SecretsService, "listServices">;

  constructor(
    private readonly db: PrismaClient = prisma,
    options: PrismaBundleBuilderOptions = {}
  ) {
    this.soulPath = options.soulPath ?? process.env.MIRA_SOUL_PATH ?? "/home/user/agent-soul/identity/SOUL.md";
    this.secretsService = options.secretsService;
  }

  async build(input: BuildBundleInput): Promise<ContextBundle> {
    const maxTokens = input.maxTokens ?? 2_000;
    const sections: BundleSection[] = [];
    const retrievalTrace: RetrievalTraceEntry[] = [];
    const policyText = await this.loadPolicyText();

    pushSection(
      sections,
      retrievalTrace,
      {
        name: "policy/system",
        content: fitContentToTokenBudget(policyText, maxTokens),
        source: policyText === SYSTEM_POLICY_TEXT ? "hardcoded:SOUL.md" : this.soulPath
      },
      maxTokens
    );

    const serviceLines = [
      "Available services:",
      "- email (SMTP send via agent.wmz.00@gmail.com)",
      "- calendar (via n8n webhook, not yet configured)"
    ];
    if (this.secretsService) {
      const services = await this.secretsService.listServices();
      const serviceNames = [...new Set(services.map((service) => service.serviceName))].sort();
      for (const serviceName of serviceNames) {
        serviceLines.push(`- ${serviceName}`);
      }
    }
    pushSection(
      sections,
      retrievalTrace,
      {
        name: "available services",
        content: serviceLines.join("\n"),
        source: "service_secrets:list"
      },
      maxTokens
    );

    const activeWorkflows = getActiveN8nWorkflows();
    pushSection(
      sections,
      retrievalTrace,
      {
        name: "n8n workflows",
        content: [
          "N8N Workflows (active):",
          ...activeWorkflows.map((workflow) => `- ${workflow.name} (${getN8nWorkflowBundleDescription(workflow)})`)
        ].join("\n"),
        source: "integrations:n8n_registry"
      },
      maxTokens
    );

    const projectProfile = input.scopeType === "project" && input.scopeId
      ? await this.db.projectProfile.findUnique({ where: { id: input.scopeId } })
      : null;
    if (projectProfile) {
      pushSection(
        sections,
        retrievalTrace,
        {
          name: "project card",
          content: serializeProjectProfile(projectProfile),
          source: `project_profile:${projectProfile.id}`
        },
        maxTokens
      );
    }

    const pinnedFacts = await this.db.memoryItem.findMany({
      where: {
        userId: input.userId,
        scopeType: "pinned",
        status: "durable"
      },
      orderBy: [{ importance: "desc" }, { updatedAt: "desc" }]
    });
    if (pinnedFacts.length > 0) {
      pushSection(
        sections,
        retrievalTrace,
        {
          name: "pinned facts",
          content: pinnedFacts.map((item: { content: string }) => `- ${item.content}`).join("\n"),
          source: "memory_items:pinned"
        },
        maxTokens,
        pinnedFacts.map((item: { id: string; importance: number }) => ({
          source: `memory_item:${item.id}`,
          reason: "Pinned durable fact",
          memoryItemId: item.id,
          score: item.importance
        }))
      );
    }

    const userTriggers = await this.db.memoryItem.findMany({
      where: {
        userId: input.userId,
        scopeType: "user_profile",
        status: "durable",
        memoryType: "adhd_trigger"
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 5
    });
    if (userTriggers.length > 0) {
      pushSection(
        sections,
        retrievalTrace,
        {
          name: "user triggers",
          content: userTriggers.map((item: { content: string }) => `- ${item.content}`).join("\n"),
          source: "memory_items:user_profile:adhd_trigger"
        },
        maxTokens,
        userTriggers.map((item: { id: string; importance: number }) => ({
          source: `memory_item:${item.id}`,
          reason: "Recent ADHD trigger",
          memoryItemId: item.id,
          score: item.importance
        }))
      );
    }

    if (input.scopeType === "project") {
      const financialContext = await this.db.memoryItem.findMany({
        where: {
          userId: input.userId,
          scopeType: "pinned",
          status: "durable",
          memoryType: "financial_context"
        },
        orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
        take: 10
      });
      if (financialContext.length > 0) {
        pushSection(
          sections,
          retrievalTrace,
          {
            name: "financial context",
            content: financialContext.map((item: { content: string }) => `- ${item.content}`).join("\n"),
            source: "memory_items:pinned:financial_context"
          },
          maxTokens,
          financialContext.map((item: { id: string; importance: number }) => ({
            source: `memory_item:${item.id}`,
            reason: "Pinned financial context",
            memoryItemId: item.id,
            score: item.importance
          }))
        );
      }
    }

    pushSection(
      sections,
      retrievalTrace,
      {
        name: "task brief",
        content: input.taskBrief,
        source: "frontdesk:task_brief"
      },
      maxTokens
    );

    const memories = await this.db.memoryItem.findMany({
      where: {
        userId: input.userId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        status: "durable"
      },
      orderBy: [{ importance: "desc" }, { updatedAt: "desc" }]
    });
    if (memories.length > 0) {
      pushSection(
        sections,
        retrievalTrace,
        {
          name: "structured memories",
          content: memories.map((item: { memoryType: string; content: string }) => `- [${item.memoryType}] ${item.content}`).join("\n"),
          source: `memory_items:${input.scopeType}:${input.scopeId ?? "none"}`
        },
        maxTokens,
        memories.map((item: { id: string; importance: number }) => ({
          source: `memory_item:${item.id}`,
          reason: "Durable scoped memory",
          memoryItemId: item.id,
          score: item.importance
        }))
      );
    }

    const rawEvents = await this.db.rawEvent.findMany({
      where: {
        userId: input.userId,
        threadId: input.scopeId ?? undefined
      },
      orderBy: { createdAt: "desc" },
      take: 3
    });
    if (rawEvents.length > 0) {
      const orderedEvents = [...rawEvents].reverse();
      pushSection(
        sections,
        retrievalTrace,
        {
          name: "recent raw events",
          content: orderedEvents.map((event) => `- ${event.messageText}`).join("\n"),
          source: "raw_events:recent"
        },
        maxTokens,
        orderedEvents.map((event) => ({
          source: `raw_event:${event.id}`,
          reason: "Recent conversation excerpt",
          rawEventId: event.id
        }))
      );
    }

    return {
      sections,
      retrievalTrace,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0)
    };
  }

  private async loadPolicyText(): Promise<string> {
    const cached = PrismaBundleBuilder.soulCache.get(this.soulPath);
    if (cached) {
      return cached;
    }

    try {
      const soulText = (await readFile(this.soulPath, "utf8")).trim();
      if (!soulText) {
        return SYSTEM_POLICY_TEXT;
      }

      PrismaBundleBuilder.soulCache.set(this.soulPath, soulText);
      return soulText;
    } catch {
      return SYSTEM_POLICY_TEXT;
    }
  }
}

const SYSTEM_POLICY_TEXT = [
  "You are Agent, the adaptive orchestrator fronted by scoped memory.",
  "Respect approval flow, policy checks, and cost accounting.",
  "Do not assume long chat history exists; work from the provided bundle.",
  "Known tools and services: telegram, email via SMTP, calendar/email read via n8n webhooks.",
  "Escalate for code, project, or risky actions. Keep explanations direct."
].join("\n");

function pushSection(
  sections: BundleSection[],
  retrievalTrace: RetrievalTraceEntry[],
  section: Omit<BundleSection, "tokens">,
  maxTokens: number,
  trace: RetrievalTraceEntry[] = []
) {
  const tokens = estimateTokens(section.content);
  const currentTokens = sections.reduce((sum, item) => sum + item.tokens, 0);
  if (currentTokens + tokens > maxTokens) {
    return;
  }

  sections.push({
    ...section,
    tokens
  });
  retrievalTrace.push(
    ...(
      trace.length > 0
        ? trace
        : [
            {
              source: section.source,
              reason: `Bundle section ${section.name}`
            }
          ]
    )
  );
}

function serializeProjectProfile(projectProfile: {
  id: string;
  name: string;
  status?: string;
  deadline?: Date | null;
  priority?: string;
  blockers?: string[];
  lastActivityAt?: Date | null;
  notes?: string | null;
  repoUrl: string | null;
  packageManager: string | null;
  buildCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  typecheckCommand: string | null;
  branchPolicy: string | null;
  prStyle: string | null;
  knownPitfalls: string[];
}): string {
  return [
    `Project: ${projectProfile.name}`,
    projectProfile.status ? `Status: ${projectProfile.status}` : null,
    projectProfile.priority ? `Priority: ${projectProfile.priority}` : null,
    projectProfile.deadline ? `Deadline: ${projectProfile.deadline.toISOString().slice(0, 10)}` : null,
    projectProfile.lastActivityAt ? `Last activity: ${projectProfile.lastActivityAt.toISOString()}` : null,
    projectProfile.repoUrl ? `Repo: ${projectProfile.repoUrl}` : null,
    projectProfile.packageManager ? `Package manager: ${projectProfile.packageManager}` : null,
    projectProfile.buildCommand ? `Build: ${projectProfile.buildCommand}` : null,
    projectProfile.testCommand ? `Test: ${projectProfile.testCommand}` : null,
    projectProfile.lintCommand ? `Lint: ${projectProfile.lintCommand}` : null,
    projectProfile.typecheckCommand ? `Typecheck: ${projectProfile.typecheckCommand}` : null,
    projectProfile.branchPolicy ? `Branch policy: ${projectProfile.branchPolicy}` : null,
    projectProfile.prStyle ? `PR style: ${projectProfile.prStyle}` : null,
    projectProfile.blockers && projectProfile.blockers.length > 0 ? `Blockers: ${projectProfile.blockers.join(", ")}` : null,
    projectProfile.knownPitfalls.length > 0 ? `Known pitfalls: ${projectProfile.knownPitfalls.join(", ")}` : null,
    projectProfile.notes ? `Notes: ${projectProfile.notes}` : null
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

function fitContentToTokenBudget(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) {
    return content;
  }

  const words = content.trim().split(/\s+/).filter(Boolean);
  const maxWords = Math.max(1, Math.floor(maxTokens / 1.3));
  return `${words.slice(0, maxWords).join(" ")}...`;
}

export type { BuildBundleInput, BundleSection, ContextBundle, MemoryScopeType, RetrievalTraceEntry };
