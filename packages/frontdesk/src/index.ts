import {
  CandidateMemory,
  FrontdeskClassification,
  MemoryScopeType,
  MessageClassification,
  ReplyMode
} from "@agent-platform/contracts";
import { PrismaLlmCallLogger, StaticPricingCatalog } from "@agent-platform/model-gateway";

export interface FrontdeskInput {
  messageText: string;
  userId?: string;
  threadId?: string;
  channel?: "telegram" | "slack" | "admin";
}

export interface FrontdeskRuntime {
  classify(input: FrontdeskInput): Promise<FrontdeskClassification>;
}

export interface NanoFrontdeskOptions {
  model?: string;
  fallbackModel?: string;
  apiUrl?: string;
  apiKey?: string;
  appName?: string;
  fallback?: FrontdeskRuntime;
}

const llmCallLogger = new PrismaLlmCallLogger(
  new StaticPricingCatalog([
    {
      provider: "openrouter",
      model: "qwen/qwen3.6-plus:free",
      pricingVersion: "2026-04-07",
      inputCostPer1m: 0,
      outputCostPer1m: 0,
      cachedInputDiscount: 0,
      effectiveFrom: "2026-04-07T00:00:00.000Z"
    },
    {
      provider: "openrouter",
      model: "minimax/minimax-m2.5:free",
      pricingVersion: "2026-04-07",
      inputCostPer1m: 0,
      outputCostPer1m: 0,
      cachedInputDiscount: 0,
      effectiveFrom: "2026-04-07T00:00:00.000Z"
    }
  ])
);

const GREETING_RE = /(^|\s)(привет|здравствуй|здравствуйте|хай|hello|hi|hey|добрый|доброе утро|добрый вечер)(\s|$|[!,.?])/i;
const BANTER_RE = /(^|\s)(как дела|как ты|как жизнь|что нового|спасибо|благодарю|thanks|thank you|пока|до свидания|bye|ок|окей|okay|ладно|понятно|хорошо|отлично|круто|класс|норм|ну ок)(\s|$|[!,.?])/i;
const CODE_RE = /\b(code|repo|repository|bug|deploy|build|test|fix|feature|pr|pull request|typescript|node|telegram webhook|tsc)\b|[./\w-]+\.(ts|tsx|js|json|md)\b/i;
const COMMAND_RE = /^\s*\/[a-z_]+/i;
const APPROVAL_RE = /\b(approve|reject|одобряю|подтверждаю|отклоняю)\b/i;

export class MockFrontdesk implements FrontdeskRuntime {
  async classify(input: FrontdeskInput): Promise<FrontdeskClassification> {
    const text = input.messageText.trim();
    const lower = text.toLowerCase();
    const entities = extractEntities(text);

    if (COMMAND_RE.test(text)) {
      return {
        classification: "command",
        replyMode: "silent",
        scope: "pinned",
        entities,
        candidateMemories: [],
        taskBrief: null,
        autoReply: null
      };
    }

    if (APPROVAL_RE.test(lower)) {
      return {
        classification: "approval_response",
        replyMode: "silent",
        scope: "task",
        entities,
        candidateMemories: [],
        taskBrief: null,
        autoReply: null
      };
    }

    // Catch junk: emoji-only, numbers-only, very short non-word messages
    const stripped = text.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").trim();
    if (stripped.length === 0 || /^\d+$/.test(stripped) || text.trim().length < 3 || /^[.!?,;:\-_=+*#@&()\[\]{}<>\/|~`'"]+$/.test(stripped)) {
      return {
        classification: "junk",
        replyMode: "frontdesk_auto",
        scope: "junk",
        entities,
        candidateMemories: [],
        taskBrief: null,
        autoReply: null
      };
    }

    if ((GREETING_RE.test(lower) || BANTER_RE.test(lower)) && text.length < 80) {
      return {
        classification: "banter",
        replyMode: "frontdesk_auto",
        scope: "junk",
        entities,
        candidateMemories: [],
        taskBrief: null,
        autoReply: selectBanterReply(lower)
      };
    }

    const classification = classifyText(text);
    const scope = inferScope(text, classification);
    const replyMode = classification === "task_request" ? "escalate_with_context" : "escalate_supervisor";
    const taskBrief = buildTaskBrief(text, classification, entities);

    return {
      classification,
      replyMode,
      scope,
      entities,
      candidateMemories: buildCandidateMemories(text, scope, classification),
      taskBrief,
      autoReply: null
    };
  }
}

export class NanoFrontdesk implements FrontdeskRuntime {
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly appName: string;
  private readonly fallback: FrontdeskRuntime;

  constructor(options: NanoFrontdeskOptions = {}) {
    this.model = options.model ?? process.env.OPENROUTER_FRONTDESK_MODEL ?? "qwen/qwen3.6-plus:free";
    this.fallbackModel = options.fallbackModel ?? process.env.OPENROUTER_FRONTDESK_FALLBACK_MODEL ?? "minimax/minimax-m2.5:free";
    this.apiUrl = options.apiUrl ?? process.env.OPENROUTER_API_URL ?? "https://openrouter.ai/api/v1/chat/completions";
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    this.appName = options.appName ?? "agent-platform-frontdesk";
    this.fallback = options.fallback ?? new MockFrontdesk();
  }

  async classify(input: FrontdeskInput): Promise<FrontdeskClassification> {
    if (!this.apiKey) {
      return this.fallback.classify(input);
    }

    try {
      const primaryAttempt = await this.invokeModel(this.model, input);
      return await this.finalizeClassification(input, primaryAttempt);
    } catch (primaryError) {
      try {
        const fallbackAttempt = await this.invokeModel(this.fallbackModel, input);
        return await this.finalizeClassification(input, fallbackAttempt);
      } catch (fallbackError) {
        logger.warn(
          {
            err: fallbackError,
            primaryError,
            userId: input.userId,
            threadId: input.threadId
          },
          "Frontdesk model call failed, using mock fallback"
        );
      }

      return this.fallback.classify(input);
    }
  }

  private async invokeModel(model: string, input: FrontdeskInput) {
    const startedAt = Date.now();
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "http-referer": "https://agent-platform.local",
        "x-title": this.appName
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: buildNanoPrompt(input.messageText)
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Frontdesk HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OpenRouterResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Missing frontdesk content");
    }

    return {
      model,
      parsed: parseFrontdeskPayload(content),
      latencyMs: Date.now() - startedAt,
      promptTokens: typeof payload.usage?.prompt_tokens === "number"
        ? payload.usage.prompt_tokens
        : estimateTokens(buildNanoPrompt(input.messageText)),
      completionTokens: typeof payload.usage?.completion_tokens === "number"
        ? payload.usage.completion_tokens
        : estimateTokens(content)
    };
  }

  private async finalizeClassification(
    input: FrontdeskInput,
    attempt: {
      model: string;
      parsed: Partial<FrontdeskClassification>;
      latencyMs: number;
      promptTokens: number;
      completionTokens: number;
    }
  ): Promise<FrontdeskClassification> {
    const result = await normalizeClassification(attempt.parsed, input.messageText, this.fallback);

    logger.info(
      {
        classification: result.classification,
        replyMode: result.replyMode,
        scope: result.scope,
        model: attempt.model,
        promptTokens: attempt.promptTokens,
        completionTokens: attempt.completionTokens,
        costUsd: 0,
        userId: input.userId,
        threadId: input.threadId
      },
      "Frontdesk classification completed"
    );

    await llmCallLogger.record({
      actor: "system",
      subagentId: "frontdesk",
      provider: "openrouter",
      model: attempt.model,
      purpose: "frontdesk_classification",
      promptTokens: attempt.promptTokens,
      completionTokens: attempt.completionTokens,
      cachedTokens: 0,
      latencyMs: attempt.latencyMs,
      estimatedCostUsd: 0
    });

    return result;
  }
}

function classifyText(text: string): MessageClassification {
  if (/\b(резюме|summary|анализ|analyze)\b/i.test(text)) {
    return "question";
  }

  if (/\b(файл|file|документ|docs\/|\.md\b|\.pdf\b|прочитай|покажи|открой)\b/i.test(text)) {
    return "task_request";
  }

  if (CODE_RE.test(text)) {
    return "task_request";
  }

  if (text.includes("?")) {
    return "question";
  }

  if (/\b(status|статус|что с задачей|где результат)\b/i.test(text)) {
    return "status_query";
  }

  if (text.length < 8) {
    return "junk";
  }

  return "context_update";
}

function inferScope(text: string, classification: MessageClassification): MemoryScopeType {
  if (classification === "banter" || classification === "junk") {
    return "junk";
  }

  if (classification === "status_query") {
    return "session_scratchpad";
  }

  if (/\b(project|repo|repository|deploy|release)\b/i.test(text)) {
    return "project";
  }

  if (/\b(я |мой |моя |предпочитаю|люблю|ненавижу)\b/i.test(text)) {
    return "user_profile";
  }

  return "task";
}

function buildTaskBrief(
  text: string,
  classification: MessageClassification,
  entities: Record<string, unknown>
): string | null {
  if (classification === "banter" || classification === "junk" || classification === "command") {
    return null;
  }

  const repo = typeof entities.repo === "string" ? ` repo=${entities.repo}` : "";
  const files = Array.isArray(entities.files) && entities.files.length > 0 ? ` files=${entities.files.join(",")}` : "";
  return text.length > 240 ? `${text.slice(0, 237)}...${repo}${files}`.trim() : `${text}${repo}${files}`.trim();
}

function buildCandidateMemories(
  text: string,
  scopeType: MemoryScopeType,
  classification: MessageClassification
): CandidateMemory[] {
  if (classification === "banter" || classification === "junk" || classification === "command") {
    return [];
  }

  return [
    {
      scopeType,
      memoryType: classification === "task_request" ? "task_signal" : "user_message",
      content: text,
      confidence: classification === "task_request" ? 0.82 : 0.62,
      importance: classification === "task_request" ? 0.85 : 0.55
    }
  ];
}

function extractEntities(text: string): Record<string, unknown> {
  const repoMatch = text.match(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/i);
  const issueMatch = text.match(/#(\d+)/);
  const files = [...text.matchAll(/\b(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|json|md)\b/g)].map((match) => match[0]);

  return {
    repo: repoMatch?.[1] ?? null,
    issue: issueMatch?.[1] ?? null,
    files,
    hasQuestion: text.includes("?")
  };
}

function selectBanterReply(lower: string): string {
  const greetingReplies = [
    "Привет! Чем могу помочь?",
    "Привет! Рада тебя видеть. Что делаем?",
    "Привет. Я на связи, рассказывай.",
    "Привет! Давай посмотрим, что нужно.",
    "Привет! С чем помочь сегодня?",
    "Привет. Что хочешь разобрать?"
  ];

  if (lower.includes("как дела")) {
    return "Хорошо, спасибо. Чем тебе помочь?";
  }

  return greetingReplies[Math.floor(Math.random() * greetingReplies.length)];
}

function buildNanoPrompt(message: string): string {
  return `You are Agent's frontdesk assistant. Classify the user message and respond in JSON.
User message: ${JSON.stringify(message)}

Respond with ONLY valid JSON:
{
  "classification": "junk|banter|question|task_request|status_query|command|approval_response|context_update",
  "replyMode": "frontdesk_auto|escalate_supervisor|escalate_with_context|silent",
  "scope": "junk|session_scratchpad|task|project|user_profile|pinned",
  "entities": {},
  "taskBrief": null or "concise task description",
  "autoReply": null or "short friendly reply in Russian, feminine voice"
}

Rules:
- Greetings, thanks, small talk = banter, frontdesk_auto, reply warmly as Agent
- Questions about status/cost = status_query, frontdesk_auto
- Slash commands = command, silent
- Code/repo/bug/deploy/task requests = task_request, escalate_supervisor
- If unclear, classify as question and escalate_with_context`;
}

async function normalizeClassification(
  parsed: Partial<FrontdeskClassification>,
  text: string,
  fallback: FrontdeskRuntime
): Promise<FrontdeskClassification> {
  const fallbackResult = await fallback.classify({ messageText: text });

  return {
    classification: isMessageClassification(parsed.classification) ? parsed.classification : fallbackResult.classification,
    replyMode: isReplyMode(parsed.replyMode) ? parsed.replyMode : fallbackResult.replyMode,
    scope: isMemoryScopeType(parsed.scope) ? parsed.scope : fallbackResult.scope,
    entities: parsed.entities && typeof parsed.entities === "object" ? parsed.entities : fallbackResult.entities,
    candidateMemories: Array.isArray(parsed.candidateMemories)
      ? parsed.candidateMemories.flatMap((memory) => normalizeCandidateMemory(memory))
      : fallbackResult.candidateMemories,
    taskBrief: typeof parsed.taskBrief === "string" || parsed.taskBrief === null ? parsed.taskBrief : fallbackResult.taskBrief,
    autoReply: typeof parsed.autoReply === "string" || parsed.autoReply === null ? parsed.autoReply : fallbackResult.autoReply
  };
}

function normalizeCandidateMemory(value: unknown): CandidateMemory[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (
    !isMemoryScopeType(candidate.scopeType) ||
    typeof candidate.memoryType !== "string" ||
    typeof candidate.content !== "string" ||
    typeof candidate.confidence !== "number" ||
    typeof candidate.importance !== "number"
  ) {
    return [];
  }

  return [
    {
      scopeType: candidate.scopeType,
      memoryType: candidate.memoryType,
      content: candidate.content,
      confidence: candidate.confidence,
      importance: candidate.importance
    }
  ];
}

function isMessageClassification(value: unknown): value is MessageClassification {
  return [
    "junk",
    "banter",
    "question",
    "task_request",
    "status_query",
    "command",
    "approval_response",
    "context_update"
  ].includes(String(value));
}

function isReplyMode(value: unknown): value is ReplyMode {
  return ["frontdesk_auto", "escalate_supervisor", "escalate_with_context", "silent"].includes(String(value));
}

function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return ["junk", "session_scratchpad", "task", "project", "user_profile", "pinned"].includes(String(value));
}

export type { CandidateMemory, FrontdeskClassification };

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

const logger = {
  info(payload: Record<string, unknown>, message: string) {
    console.info(message, payload);
  },
  warn(payload: Record<string, unknown>, message: string) {
    console.warn(message, payload);
  }
};

function parseFrontdeskPayload(content: string): Partial<FrontdeskClassification> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid frontdesk JSON payload");
  }

  return parsed as Partial<FrontdeskClassification>;
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.trim().split(/\s+/).filter(Boolean).length * 1.3));
}
