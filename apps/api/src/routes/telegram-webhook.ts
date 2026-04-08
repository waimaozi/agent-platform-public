import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  cancelTask,
  getTaskCostBreakdown,
  getTaskStatusSnapshot,
  prisma,
  pauseTask,
  resumeTask
} from "@agent-platform/core";
import { BuildBundleInput, FrontdeskClassification } from "@agent-platform/contracts";
import { PrismaBundleBuilder } from "@agent-platform/bundle-builder";
import { MockFrontdesk, NanoFrontdesk } from "@agent-platform/frontdesk";
import {
  EmailClient,
  findN8nWorkflow,
  formatN8nWorkflowStatus,
  getUserSafeErrorMessage,
  formatTaskCreated,
  N8N_WORKFLOWS,
  N8nClient,
  TELEGRAM_HELP_MESSAGE,
  TELEGRAM_WELCOME_MESSAGE
} from "@agent-platform/integrations";
import { PrismaMemoryFabric } from "@agent-platform/memory-fabric";
import { formatProjectDetails, formatProjectList, ProjectTrackerService } from "../lib/project-tracker.js";
import { buildActivityReport, formatActivityReport } from "../lib/reporting.js";
import { transcribeTelegramVoiceNote } from "../lib/voice-notes.js";
import {
  applyApprovalDecision,
  buildContainer,
  createInitialTaskArtifacts,
  enqueueTask,
  findOrCreateUser
} from "../lib/container.js";

const telegramMessageSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      text: z.string().optional(),
      voice: z.object({
        file_id: z.string(),
        duration: z.number(),
        mime_type: z.string().optional(),
        file_size: z.number().optional()
      }).optional(),
      chat: z.object({
        id: z.number()
      }),
      from: z.object({
        id: z.number(),
        username: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional()
      })
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string(),
      from: z.object({
        id: z.number()
      }),
      message: z.object({
        chat: z.object({
          id: z.number()
        })
      })
    })
    .optional()
});

export async function registerTelegramWebhook(app: FastifyInstance) {
  const container = await buildContainer();
  const scopedMemoryEnabled = (process.env.FEATURE_SCOPED_MEMORY ?? "false") === "true";
  const frontdesk =
    (process.env.FEATURE_SCOPED_MEMORY_NANO ?? "false") === "true" ? new NanoFrontdesk() : new MockFrontdesk();
  const memoryFabric = new PrismaMemoryFabric();
  const bundleBuilder = new PrismaBundleBuilder();

  app.post("/webhooks/telegram", async (request, reply) => {
    try {
      const payload = telegramMessageSchema.parse(request.body);

      if (payload.message) {
        const user = await findOrCreateUser({
          telegramUserId: String(payload.message.from.id),
          username: payload.message.from.username,
          firstName: payload.message.from.first_name,
          lastName: payload.message.from.last_name
        });
        const voiceResult = scopedMemoryEnabled && payload.message.voice
          ? await maybeTranscribeVoiceMessage({
              userId: user.id,
              payload,
              request
            })
          : null;
        const rawText = payload.message.text ?? voiceResult?.text ?? "";
        const messageText = truncateTelegramMessage(rawText, request);

        if (!messageText.trim()) {
          return reply.send({ ok: true, ignored: true });
        }

        const presetCommandMessage = getPresetTelegramCommandMessage(messageText);
        if (presetCommandMessage) {
          await container.telegramClient.sendMessage({
            chatId: String(payload.message.chat.id),
            text: presetCommandMessage
          });
          return reply.send({ ok: true, command: true, preset: true });
        }

        if (scopedMemoryEnabled) {
          const rawEvent = await prisma.rawEvent.create({
            data: {
              userId: user.id,
              channel: "telegram",
              threadId: String(payload.message.chat.id),
              messageText,
              messageId: String(payload.message.message_id),
              metadata: {
                updateId: payload.update_id,
                from: payload.message.from.username ?? null,
                voice: payload.message.voice
                  ? {
                      fileId: payload.message.voice.file_id,
                      duration: payload.message.voice.duration,
                      filePath: voiceResult?.filePath ?? null
                    }
                  : undefined
              }
            }
          });

          const classification = await frontdesk.classify({
            messageText,
            userId: user.id,
            threadId: String(payload.message.chat.id),
            channel: "telegram"
          });

          await prisma.rawEvent.update({
            where: { id: rawEvent.id },
            data: {
              classification: classification.classification,
              replyMode: classification.replyMode,
              scope: classification.scope,
              entities: classification.entities as Prisma.InputJsonValue,
              taskBrief: classification.taskBrief
            }
          });

          await persistCandidateMemories(memoryFabric, classification, {
            userId: user.id,
            rawEventId: rawEvent.id
          });

          if (classification.classification === "command") {
            const commandResponse = await maybeHandleScopedMemoryCommand({
              userId: user.id,
              text: messageText,
              chatId: String(payload.message.chat.id),
              services: {
                emailClient: container.emailClient,
                n8nClient: container.n8nClient
              }
            });

            if (commandResponse) {
              await container.telegramClient.sendMessage({
                chatId: String(payload.message.chat.id),
                text: commandResponse
              });
            }

            return reply.send({ ok: true, command: true, scopedMemory: true });
          }

          if (classification.replyMode === "frontdesk_auto") {
            if (classification.autoReply) {
              await container.telegramClient.sendMessage({
                chatId: String(payload.message.chat.id),
                text: classification.autoReply
              });
            }

            return reply.send({ ok: true, routed: "frontdesk_auto" });
          }

          if (
            classification.replyMode === "escalate_supervisor" ||
            classification.replyMode === "escalate_with_context"
          ) {
            const projectProfile = await resolveProjectProfile(user.id, classification);
            const bundleInput: BuildBundleInput = {
              userId: user.id,
              taskBrief: classification.taskBrief ?? messageText,
              scopeType: classification.scope,
              scopeId:
                classification.scope === "project"
                  ? projectProfile?.id
                  : classification.scope === "task"
                    ? String(payload.message.chat.id)
                    : undefined
            };
            const contextBundle = await bundleBuilder.build(bundleInput);
            const created = await createInitialTaskArtifacts({
              userId: user.id,
              chatId: String(payload.message.chat.id),
              rawInput: messageText,
              projectProfileId: projectProfile?.id ?? null,
              autoEnqueue: false,
              metadata: {
                rawEventId: rawEvent.id,
                scopedMemory: true,
                scope: classification.scope,
                replyMode: classification.replyMode
              }
            });

            if (projectProfile?.id) {
              await (prisma.projectProfile as any).update({
                where: { id: projectProfile.id },
                data: { lastActivityAt: new Date() }
              });
            }

            await prisma.contextBundle.create({
              data: {
                taskId: created.taskId,
                userId: user.id,
                purpose: classification.taskBrief ?? messageText,
                bundleJson: contextBundle as unknown as Prisma.InputJsonValue,
                retrievalTrace: contextBundle.retrievalTrace as unknown as Prisma.InputJsonValue,
                totalTokens: contextBundle.totalTokens
              }
            });

            if (!created.approvalNeeded) {
              await container.telegramClient.sendChatAction(String(payload.message.chat.id), "typing");
              await enqueueTask(created.taskId);
            }

            const message = formatTaskCreated(created.taskId, classification.taskBrief ?? messageText);
            await container.telegramClient.sendMessage({
              chatId: String(payload.message.chat.id),
              text: message,
              parseMode: "MarkdownV2",
              replyMarkup: created.approvalNeeded && created.approvalId
                ? {
                    inline_keyboard: [
                      [
                        {
                          text: "Approve",
                          callback_data: `approval:${created.approvalId}:approve`
                        },
                        {
                          text: "Reject",
                          callback_data: `approval:${created.approvalId}:reject`
                        }
                      ]
                    ]
                  }
                : undefined
            });

            return reply.send({
              ok: true,
              taskId: created.taskId,
              approvalNeeded: created.approvalNeeded,
              scopedMemory: true
            });
          }

          return reply.send({ ok: true, ignored: true, scopedMemory: true });
        }

        const commandResponse = await maybeHandleTelegramCommand({
          text: messageText,
          chatId: String(payload.message.chat.id)
        });

        if (commandResponse) {
          await container.telegramClient.sendMessage({
            chatId: String(payload.message.chat.id),
            text: commandResponse
          });

          return reply.send({ ok: true, command: true });
        }

        const created = await createInitialTaskArtifacts({
          userId: user.id,
          chatId: String(payload.message.chat.id),
          rawInput: messageText,
          autoEnqueue: false
        });

        if (!created.approvalNeeded) {
          await container.telegramClient.sendChatAction(String(payload.message.chat.id), "typing");
          await enqueueTask(created.taskId);
        }

        const message = formatTaskCreated(created.taskId, messageText);

        await container.telegramClient.sendMessage({
          chatId: String(payload.message.chat.id),
          text: message,
          parseMode: "MarkdownV2",
          replyMarkup: created.approvalNeeded
            ? {
                inline_keyboard: [
                  [
                    {
                      text: "Approve",
                      callback_data: `approval:${created.approvalId}:approve`
                    },
                    {
                      text: "Reject",
                      callback_data: `approval:${created.approvalId}:reject`
                    }
                  ]
                ]
              }
            : undefined
        });

        return reply.send({
          ok: true,
          taskId: created.taskId,
          approvalNeeded: created.approvalNeeded
        });
      }

      if (payload.callback_query) {
        const [kind, approvalId, decision] = payload.callback_query.data.split(":");
        if (kind !== "approval" || !approvalId || (decision !== "approve" && decision !== "reject")) {
          await container.telegramClient.answerCallbackQuery(
            payload.callback_query.id,
            "Unsupported callback payload"
          );
          return reply.send({ ok: false, error: "Unsupported callback payload" });
        }

        const callbackUser = await findOrCreateUser({
          telegramUserId: String(payload.callback_query.from.id)
        });

        const result = await applyApprovalDecision({
          approvalId,
          decision,
          decidedByUserId: callbackUser.id
        });

        if (!result.applied) {
          await container.telegramClient.answerCallbackQuery(payload.callback_query.id, result.error);
          return reply.send({ ok: false, error: result.error });
        }

        if (!result.taskId || !result.taskState) {
          throw new Error("Approval decision result missing task context");
        }

        if (decision === "approve") {
          await prisma.task.findUniqueOrThrow({ where: { id: result.taskId } });
          const { enqueueTask } = await import("../lib/container.js");
          await enqueueTask(result.taskId, { resumeAfterApproval: true });
        }

        await container.telegramClient.sendMessage({
          chatId: String(payload.callback_query.message.chat.id),
          text: decision === "approve" ? "Подтверждение получено. Продолжаю." : "Запрос отменён."
        });
        await container.telegramClient.answerCallbackQuery(
          payload.callback_query.id,
          decision === "approve" ? "Подтверждено." : "Отклонено."
        );

        return reply.send({ ok: true, approvalId, decision });
      }

      return reply.send({ ok: true, ignored: true });
    } catch (error) {
      request.log.error({ err: error }, "telegram webhook processing failed");
      return reply.code(200).send({
        ok: false,
        error: describeWebhookError(error)
      });
    }
  });
}

function truncateTelegramMessage(text: string, request: { log: FastifyInstance["log"] }): string {
  if (text.length <= 4000) {
    return text;
  }

  request.log.warn({ originalLength: text.length }, "telegram message exceeded 4000 chars and was truncated");
  return text.slice(0, 4000);
}

function describeWebhookError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

export function getPresetTelegramCommandMessage(text: string): string | null {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase();

  if (command === "/start") {
    return TELEGRAM_WELCOME_MESSAGE;
  }

  if (command === "/help") {
    return TELEGRAM_HELP_MESSAGE;
  }

  return null;
}

async function maybeTranscribeVoiceMessage(input: {
  userId: string;
  payload: z.infer<typeof telegramMessageSchema>;
  request: { log: FastifyInstance["log"] };
}) {
  if (!input.payload.message?.voice) {
    return null;
  }

  try {
    return await transcribeTelegramVoiceNote({
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      voice: input.payload.message.voice,
      groqApiKey: process.env.GROQ_API_KEY ?? ""
    });
  } catch (error) {
    input.request.log.error({ err: error }, "voice transcription failed");
    await prisma.rawEvent.create({
      data: {
        userId: input.userId,
        channel: "telegram",
        threadId: String(input.payload.message.chat.id),
        messageText: "[voice message]",
        messageId: String(input.payload.message.message_id),
        metadata: {
          updateId: input.payload.update_id,
          note: "Voice message received but transcription failed",
          voice: {
            fileId: input.payload.message.voice.file_id,
            duration: input.payload.message.voice.duration
          }
        }
      }
    });
    return null;
  }
}

export async function maybeHandleScopedMemoryCommand(input: {
  userId: string;
  text: string;
  chatId: string;
  services?: {
    emailClient: EmailClient;
    n8nClient: N8nClient;
  };
}): Promise<string | null> {
  const parts = input.text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const argument = input.text.trim().slice(command?.length ?? 0).trim();
  const memoryFabric = new PrismaMemoryFabric();
  const projectTracker = new ProjectTrackerService();

  if (!command?.startsWith("/")) {
    return null;
  }

  if (command === "/pin") {
    if (!argument) {
      return "Usage: /pin <content>";
    }

    const memory = await memoryFabric.pin(input.userId, argument);
    return `Pinned memory ${memory.id}.`;
  }

  if (command === "/forget") {
    if (!argument) {
      return "Usage: /forget <memoryId>";
    }

    await memoryFabric.forget(argument);
    return `Memory ${argument} forgotten.`;
  }

  if (command === "/why-context") {
    const bundle = await prisma.contextBundle.findFirst({
      where: { userId: input.userId },
      orderBy: { createdAt: "desc" }
    });

    if (!bundle) {
      return "No context bundle found.";
    }

    const trace = parseRetrievalTrace(bundle.retrievalTrace);
    const lines = [
      "Почему у Миры был такой контекст:",
      `Bundle ID: ${bundle.id}`,
      `Purpose: ${bundle.purpose}`,
      `Total tokens: ${bundle.totalTokens}`
    ];

    if (trace.length === 0) {
      lines.push("Trace is empty.");
      return lines.join("\n");
    }

    lines.push("", "Retrieval trace:");
    lines.push(...trace.map((entry, index) => formatTraceEntry(entry, index + 1)));
    return lines.join("\n");
  }

  if (command === "/project") {
    if (!argument) {
      const active = await getActiveProjectMemory(input.userId);
      return active ? `Current project: ${active.content}` : "Usage: /project list | /project add <name> | /project update <name> <field>=<value> | /project <name>";
    }

    if (argument === "list") {
      const projects = await projectTracker.listProjects();
      return formatProjectList(projects);
    }

    if (argument.startsWith("add ")) {
      const project = await projectTracker.addProject(argument.slice(4));
      await memoryFabric.pin(input.userId, `active_project:${project.id}:${project.name}`, project.id);
      return `Project created: ${project.name}`;
    }

    if (argument.startsWith("update ")) {
      const updatePayload = parseProjectUpdateCommand(argument.slice(7));
      const project = await projectTracker.updateProject(updatePayload.name, updatePayload.field, updatePayload.value);
      return `Project updated: ${project.name}`;
    }

    const project = await projectTracker.getProject(argument);
    if (!project) {
      return `Project ${argument} not found.`;
    }

    await memoryFabric.pin(input.userId, `active_project:${project.id}:${project.name}`, project.id);
    return `${formatProjectDetails(project)}\nActive project set to ${project.name}.`;
  }

  if (command === "/deadline") {
    const parsed = parseDeadlineCommand(argument);
    const project = await projectTracker.setDeadline(parsed.projectName, parsed.date) as any;
    return `Deadline set: ${project.name} -> ${project.deadline?.toISOString().slice(0, 10) ?? "none"}`;
  }

  if (command === "/log-trigger") {
    if (!argument) {
      return "Usage: /log-trigger <description>";
    }

    const memory = await memoryFabric.createDurable({
      userId: input.userId,
      scopeType: "user_profile",
      scopeId: input.userId,
      memoryType: "adhd_trigger",
      content: argument,
      importance: 0.9,
      confidence: 0.95
    });
    return `Trigger logged: ${memory.id}`;
  }

  if (command === "/triggers") {
    const triggers = await prisma.memoryItem.findMany({
      where: {
        userId: input.userId,
        scopeType: "user_profile",
        status: "durable",
        memoryType: "adhd_trigger"
      },
      orderBy: { updatedAt: "desc" },
      take: 20
    });
    return triggers.length > 0
      ? ["ADHD triggers:", ...triggers.map((item) => `- ${item.content}`)].join("\n")
      : "No ADHD triggers logged.";
  }

  if (command === "/finance") {
    if (argument === "list") {
      const facts = await prisma.memoryItem.findMany({
        where: {
          userId: input.userId,
          scopeType: "pinned",
          status: "durable",
          memoryType: "financial_context"
        },
        orderBy: { updatedAt: "desc" },
        take: 20
      });
      return facts.length > 0
        ? ["Financial context:", ...facts.map((item) => `- ${item.content}`)].join("\n")
        : "No financial context stored.";
    }

    if (!argument) {
      return "Usage: /finance <fact> or /finance list";
    }

    const memory = await memoryFabric.pin(input.userId, argument, undefined, "financial_context");
    return `Financial fact saved: ${memory.id}`;
  }

  if (command === "/report") {
    const weekly = argument.toLowerCase() === "weekly";
    const report = await buildActivityReport({
      userId: input.userId,
      days: weekly ? 7 : 1
    });
    return formatActivityReport(report, weekly ? "7d" : "24h");
  }

  if (command === "/email") {
    if (!argument) {
      return getEmailHelpText();
    }

    if (argument === "read") {
      await triggerN8nWebhook(input.services?.n8nClient, "mira-email-read", {
        userId: input.userId,
        chatId: input.chatId
      });
      return "Email reading via n8n — webhook not configured yet. Use /email send to send.";
    }

    if (argument.startsWith("send ")) {
      const emailInput = parseEmailSendCommand(argument.slice(5));
      const delivery = await sendScopedMemoryEmail({
        services: input.services,
        emailInput
      });
      return delivery === "n8n"
        ? `Письмо отправлено на ${emailInput.to} через Chemitech mail agent`
        : `Письмо отправлено на ${emailInput.to}`;
    }

    return getEmailHelpText();
  }

  if (command === "/n8n") {
    if (!argument) {
      return getN8nHelpText();
    }

    if (argument === "list") {
      return [
        "N8N workflows:",
        ...N8N_WORKFLOWS.map((workflow) =>
          `- ${workflow.name} [${formatN8nWorkflowStatus(workflow)}] -> ${workflow.webhookPath}`
        )
      ].join("\n");
    }

    if (argument.startsWith("call ")) {
      const { workflowName, payload } = parseN8nCallCommand(argument.slice(5));
      const workflow = findN8nWorkflow(workflowName);

      if (!workflow) {
        return `Unknown n8n workflow: ${workflowName}`;
      }

      if (!workflow.active) {
        return `Workflow ${workflow.name} is inactive.`;
      }

      const response = await callRegisteredN8nWorkflow(input.services?.n8nClient, workflow.webhookPath, payload);
      return formatN8nCallResponse(workflow.name, response);
    }

    return getN8nHelpText();
  }

  if (command === "/calendar") {
    if (argument.toLowerCase() === "help") {
      return getCalendarHelpText();
    }

    await triggerN8nWebhook(input.services?.n8nClient, "mira-calendar-events", {
      userId: input.userId,
      chatId: input.chatId
    });
    return "Calendar via n8n — webhook not configured yet.";
  }

  if (command === "/status" || command === "/cost") {
    return maybeHandleTelegramCommand({
      text: input.text,
      chatId: input.chatId
    });
  }

  return maybeHandleTelegramCommand({
    text: input.text,
    chatId: input.chatId
  });
}

async function persistCandidateMemories(
  memoryFabric: PrismaMemoryFabric,
  classification: FrontdeskClassification,
  context: { userId: string; rawEventId: string }
) {
  for (const memory of classification.candidateMemories) {
    await memoryFabric.createCandidate({
      scopeType: memory.scopeType,
      scopeId: context.userId,
      memoryType: memory.memoryType,
      content: memory.content,
      confidence: memory.confidence,
      importance: memory.importance,
      userId: context.userId,
      sourceEventIds: [context.rawEventId]
    });
  }
}

async function resolveProjectProfile(userId: string, classification: FrontdeskClassification) {
  const repo = typeof classification.entities.repo === "string" ? classification.entities.repo : null;
  if (repo) {
    const direct = await prisma.projectProfile.findFirst({
      where: {
        repoUrl: {
          contains: repo,
          mode: "insensitive"
        }
      }
    });
    if (direct) {
      return direct;
    }
  }

  const active = await getActiveProjectMemory(userId);
  const activeProjectId = active?.content.split(":")[1];
  if (!activeProjectId) {
    return null;
  }

  return prisma.projectProfile.findUnique({
    where: { id: activeProjectId }
  });
}

async function getActiveProjectMemory(userId: string) {
  return prisma.memoryItem.findFirst({
    where: {
      userId,
      scopeType: "pinned",
      status: "durable",
      content: { startsWith: "active_project:" }
    },
    orderBy: { createdAt: "desc" }
  });
}

function parseProjectUpdateCommand(argument: string) {
  const assignmentIndex = argument.lastIndexOf(" ");
  if (assignmentIndex === -1) {
    throw new Error("Usage: /project update <name> <field>=<value>");
  }

  const name = argument.slice(0, assignmentIndex).trim();
  const assignment = argument.slice(assignmentIndex + 1).trim();
  const equalsIndex = assignment.indexOf("=");
  if (!name || equalsIndex === -1) {
    throw new Error("Usage: /project update <name> <field>=<value>");
  }

  return {
    name,
    field: assignment.slice(0, equalsIndex).trim(),
    value: assignment.slice(equalsIndex + 1).trim()
  };
}

function parseDeadlineCommand(argument: string) {
  const parts = argument.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error("Usage: /deadline <project> <date>");
  }

  const date = parts[parts.length - 1]!;
  const projectName = argument.slice(0, argument.length - date.length).trim();
  if (!projectName) {
    throw new Error("Usage: /deadline <project> <date>");
  }

  return { projectName, date };
}

function parseEmailSendCommand(argument: string) {
  const trimmed = argument.trim();
  const firstSpace = trimmed.indexOf(" ");
  const separator = trimmed.indexOf("|");

  if (firstSpace === -1 || separator === -1 || separator <= firstSpace) {
    throw new Error("Usage: /email send <to> <subject> | <body>");
  }

  const to = trimmed.slice(0, firstSpace).trim();
  const subject = trimmed.slice(firstSpace + 1, separator).trim();
  const body = trimmed.slice(separator + 1).trim();
  if (!to || !subject || !body) {
    throw new Error("Usage: /email send <to> <subject> | <body>");
  }

  return { to, subject, body };
}

function parseN8nCallCommand(argument: string) {
  const trimmed = argument.trim();
  if (!trimmed) {
    throw new Error("Usage: /n8n call <name> [json data]");
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return { workflowName: trimmed, payload: {} as Record<string, unknown> };
  }

  const workflowName = trimmed.slice(0, firstSpace).trim();
  const jsonPayload = trimmed.slice(firstSpace + 1).trim();
  if (!jsonPayload) {
    return { workflowName, payload: {} as Record<string, unknown> };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload);
  } catch {
    throw new Error("Usage: /n8n call <name> [json data]");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Usage: /n8n call <name> [json data]");
  }

  return { workflowName, payload: parsed as Record<string, unknown> };
}

function getEmailHelpText() {
  return [
    "Email commands:",
    "/email send <to> <subject> | <body>",
    "/email read"
  ].join("\n");
}

function getCalendarHelpText() {
  return [
    "Calendar commands:",
    "/calendar",
    "/calendar help"
  ].join("\n");
}

function getN8nHelpText() {
  return [
    "N8N commands:",
    "/n8n list",
    "/n8n call <name> [json data]"
  ].join("\n");
}

async function triggerN8nWebhook(
  client: N8nClient | undefined,
  path: string,
  data?: Record<string, unknown>
) {
  if (!client) {
    return;
  }

  try {
    await client.callWebhook(path, data);
  } catch {
    return;
  }
}

async function callRegisteredN8nWorkflow(
  client: N8nClient | undefined,
  path: string,
  data?: Record<string, unknown>
) {
  if (!client) {
    throw new Error("N8N client is not configured");
  }

  return client.callWebhook(path, data);
}

async function sendScopedMemoryEmail(input: {
  services: {
    emailClient: EmailClient;
    n8nClient: N8nClient;
  } | undefined;
  emailInput: {
    to: string;
    subject: string;
    body: string;
    html?: string;
  };
}): Promise<"smtp" | "n8n"> {
  if (isChemitechRecipient(input.emailInput.to)) {
    await callRegisteredN8nWorkflow(input.services?.n8nClient, "imap-agent", input.emailInput);
    return "n8n";
  }

  await input.services?.emailClient.send(input.emailInput);
  return "smtp";
}

function isChemitechRecipient(address: string): boolean {
  return address.trim().toLowerCase().endsWith("@chemitech.ru");
}

function formatN8nCallResponse(workflowName: string, response: unknown): string {
  if (typeof response === "string") {
    return response;
  }

  if (response && typeof response === "object" && !Array.isArray(response)) {
    const candidate = response as Record<string, unknown>;
    if (typeof candidate.response === "string") {
      return candidate.response;
    }
    if (typeof candidate.message === "string") {
      return candidate.message;
    }
  }

  return `${workflowName} response:\n${JSON.stringify(response, null, 2)}`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function parseRetrievalTrace(value: unknown): Array<{
  source: string;
  reason: string;
  memoryItemId?: string;
  rawEventId?: string;
  score?: number;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.source !== "string" || typeof candidate.reason !== "string") {
      return [];
    }

    return [
      {
        source: candidate.source,
        reason: candidate.reason,
        memoryItemId: typeof candidate.memoryItemId === "string" ? candidate.memoryItemId : undefined,
        rawEventId: typeof candidate.rawEventId === "string" ? candidate.rawEventId : undefined,
        score: typeof candidate.score === "number" ? candidate.score : undefined
      }
    ];
  });
}

function formatTraceEntry(
  entry: {
    source: string;
    reason: string;
    memoryItemId?: string;
    rawEventId?: string;
    score?: number;
  },
  index: number
): string {
  const details = [
    entry.memoryItemId ? `memory=${entry.memoryItemId}` : null,
    entry.rawEventId ? `event=${entry.rawEventId}` : null,
    typeof entry.score === "number" ? `score=${entry.score.toFixed(2)}` : null
  ].filter((value): value is string => Boolean(value));

  return `${index}. ${entry.reason}\nsource: ${entry.source}${details.length > 0 ? ` | ${details.join(" | ")}` : ""}`;
}

async function maybeHandleTelegramCommand(input: {
  text: string;
  chatId: string;
}): Promise<string | null> {
  const parts = input.text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const taskId = parts[1];

  if (!command || !command.startsWith("/")) {
    return null;
  }

  if (!["/status", "/pause", "/resume", "/cancel", "/cost"].includes(command)) {
    return null;
  }

  if (!taskId) {
    return `Usage: ${command} <taskId>`;
  }

  try {
    if (command === "/status") {
      const task = await getTaskStatusSnapshot(taskId);
      if (!task) {
        return `Task ${taskId} not found.`;
      }

      const snapshot = task.costSnapshots[0];
      return [
        `Task ${task.id}`,
        `State: ${task.state}`,
        snapshot
          ? `Cost: $${snapshot.totalEstimatedCostUsd.toFixed(6)} | in ${snapshot.totalInputTokens} | out ${snapshot.totalOutputTokens}`
          : "Cost: no snapshots yet"
      ].join("\n");
    }

    if (command === "/cost") {
      const task = await getTaskCostBreakdown(taskId);
      if (!task) {
        return `Task ${taskId} not found.`;
      }

      const snapshot = task.costSnapshots[0];
      const breakdown = snapshot?.modelBreakdownJson as Record<string, number> | undefined;
      const lines = [
        `Task ${task.id} cost breakdown`,
        snapshot ? `Total estimated: $${snapshot.totalEstimatedCostUsd.toFixed(6)}` : "Total estimated: $0.000000",
        snapshot ? `Tokens: in ${snapshot.totalInputTokens} | out ${snapshot.totalOutputTokens}` : "Tokens: in 0 | out 0"
      ];

      if (breakdown && Object.keys(breakdown).length > 0) {
        for (const [modelKey, cost] of Object.entries(breakdown)) {
          lines.push(`${modelKey}: $${cost.toFixed(6)}`);
        }
      }

      if (task.llmCallLogs.length > 0) {
        lines.push(`LLM calls: ${task.llmCallLogs.length}`);
      }

      return lines.join("\n");
    }

    if (command === "/pause") {
      const task = await pauseTask(taskId, "Paused from Telegram command");
      return `Task ${taskId} paused. Current state: ${task?.state ?? "unknown"}.`;
    }

    if (command === "/resume") {
      const task = await resumeTask(taskId, "Resumed from Telegram command");
      await enqueueTask(taskId);
      return `Task ${taskId} resumed. Current state: ${task?.state ?? "unknown"}.`;
    }

    if (command === "/cancel") {
      const task = await cancelTask(taskId, "Cancelled from Telegram command");
      return `Task ${taskId} cancelled. Current state: ${task?.state ?? "unknown"}.`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : null;
    return getUserSafeErrorMessage(message);
  }

  return null;
}
