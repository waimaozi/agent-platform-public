import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync as fsWriteFile, appendFileSync, existsSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";

// ============================================================
// Config
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CLAUDE_PATH = process.env.CLAUDE_CODE_PATH ?? "claude";
const SOUL_PATH = process.env.MIRA_SOUL_PATH ?? "/home/openclaw/mira-soul/identity/FULL-CONTEXT.md";
const ADMIN_CHAT_ID = process.env.TELEGRAM_BOOTSTRAP_CHAT_ID ?? "";
const PORT = Number(process.env.API_PORT ?? 3000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const CLAUDE_TIMEOUT = 600_000; // 10 minutes max

// ============================================================
// Telegram client (minimal)
// ============================================================
async function tgSend(chatId: string, text: string): Promise<void> {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  }).catch(() => {});
}

async function tgTyping(chatId: string): Promise<void> {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" })
  }).catch(() => {});
}

// ============================================================
// Frontdesk — regex filter
// ============================================================
const GREETING_RE = /^(привет|здравствуй|здравствуйте|хай|hello|hi|hey|добрый|доброе утро|добрый вечер|добрый день)[!.?,\s]*$/i;
const BANTER_RE = /^(как дела|как ты|как жизнь|что нового|спасибо|благодарю|thanks|thank you|пока|до свидания|bye|ок|окей|okay|ладно|понятно|хорошо|отлично|круто|класс|норм|ну ок|да|нет|ага)[!.?,\s]*$/i;
const JUNK_RE = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}.!?,;:\-_=+*#@&()\[\]{}<>\/|~`'"…\d]*$/u;

const BANTER_REPLIES = [
  "Привет! Чем могу помочь?",
  "Привет! Рада тебя видеть. Что делаем?",
  "Здравствуй! Слушаю.",
  "Привет! Готова к работе.",
];

function classifyMessage(text: string): "banter" | "junk" | "command" | "real" {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) return "junk";
  if (JUNK_RE.test(trimmed)) return "junk";
  if (GREETING_RE.test(trimmed) || BANTER_RE.test(trimmed)) return "banter";
  if (trimmed.startsWith("/")) return "command";
  return "real";
}

// ============================================================
// Claude CLI caller — ONE function, no fallbacks
// ============================================================
function callClaude(prompt: string): Promise<{ text: string; cost: number; tokens: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--add-dir", "/home/openclaw/mira-soul",
      "--add-dir", "/home/openclaw/.openclaw/workspace",
      "--max-turns", "50",
    ];

    // Add system prompt file if it exists
    try {
      readFileSync(SOUL_PATH);
      args.push("--system-prompt-file", SOUL_PATH);
    } catch {}

    const child = spawn(CLAUDE_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude timeout"));
    }, CLAUDE_TIMEOUT);

    child.on("close", () => {
      clearTimeout(timer);
      // Try to parse JSON from stdout regardless of exit code
      try {
        const envelope = JSON.parse(stdout.trim());
        const text = envelope.result ?? "";
        const cost = envelope.total_cost_usd ?? 0;
        const usage = envelope.usage ?? {};
        const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        resolve({ text, cost, tokens });
      } catch {
        reject(new Error(stderr.trim() || "Claude returned no output"));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================
// Command handlers
// ============================================================
const HELP_TEXT = `Команды:
/start — приветствие
/help — список команд
/pin <факт> — запомнить факт
/cost — последние расходы

Или просто напиши вопрос — я разберусь.`;

const WELCOME_TEXT = `Привет! Я Мира — AI-ассистент.

${HELP_TEXT}`;

// Simple in-memory pin store (persists in Postgres later if needed)
const pinnedFacts: Map<string, string[]> = new Map();

function handleCommand(text: string, chatId: string): string | null {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const rest = text.slice(cmd.length).trim();

  switch (cmd) {
    case "/start": return WELCOME_TEXT;
    case "/help": return HELP_TEXT;
    case "/pin": {
      if (!rest) return "Напиши: /pin <факт для запоминания>";
      const facts = pinnedFacts.get(chatId) ?? [];
      facts.push(rest);
      pinnedFacts.set(chatId, facts);
      return `📌 Запомнила: ${rest}`;
    }
    case "/cost": return "📊 Стоимость зависит от задачи. Простой вопрос ~$0.04, сложный ~$0.15.";
    default: return null;
  }
}

// ============================================================
// Webhook schema
// ============================================================
const webhookSchema = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    text: z.string().optional(),
    caption: z.string().optional(),
    chat: z.object({ id: z.number() }).passthrough(),
    from: z.object({
      id: z.number(),
      username: z.string().optional(),
      first_name: z.string().optional(),
    }).passthrough(),
    document: z.object({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
      file_size: z.number().optional(),
    }).passthrough().optional(),
    photo: z.array(z.object({
      file_id: z.string(),
    }).passthrough()).optional(),
    voice: z.object({
      file_id: z.string(),
    }).passthrough().optional(),
    forward_from: z.unknown().optional(),
    forward_date: z.number().optional(),
  }).passthrough().optional(),
  callback_query: z.object({
    id: z.string(),
    data: z.string(),
    from: z.object({ id: z.number() }).passthrough(),
    message: z.object({ chat: z.object({ id: z.number() }).passthrough() }).passthrough()
  }).passthrough().optional()
}).passthrough();

// ============================================================
// Telegram file download
// ============================================================
async function downloadTgFile(fileId: string, filename?: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const data = await res.json() as { ok: boolean; result?: { file_path: string } };
    if (!data.ok || !data.result?.file_path) return null;

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    const ext = data.result.file_path.split(".").pop() ?? "bin";
    const saveName = filename ?? `tg-file-${Date.now()}.${ext}`;
    const savePath = `/tmp/${saveName}`;

    // Use safe filename (no spaces, no Cyrillic)
    const safeFilename = `tg-${Date.now()}.${ext}`;
    const safePath = `/tmp/${safeFilename}`;
    fsWriteFile(safePath, buffer);
    console.log("FILE SAVED:", safePath, buffer.length, "bytes", "original:", filename);

    // Convert DOCX/DOC to plain text for Claude to read
    if (ext === "docx" || ext === "doc") {
      try {
        const txtPath = safePath.replace(/\.(docx?)/i, ".txt");
        execSync(`pandoc "${safePath}" -t plain -o "${txtPath}"`, { timeout: 10000 });
        console.log("CONVERTED to text:", txtPath);
        return txtPath;
      } catch (e) {
        console.error("DOCX conversion failed:", e instanceof Error ? e.message : e);
      }
    }
    return safePath;
  } catch (err) {
    console.error("FILE DOWNLOAD ERROR:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ============================================================
// Server
// ============================================================
const app = Fastify({ logger: false });

app.get("/health", async () => ({ ok: true, now: new Date().toISOString() }));

app.post("/webhooks/telegram", async (request, reply) => {
  try {
    // Log raw payload for debugging file issues
    const raw = request.body as Record<string, unknown>;
    const rawMsg = raw?.message as Record<string, unknown> | undefined;
    if (rawMsg && (rawMsg.document || rawMsg.photo || rawMsg.voice)) {
      console.log("FILE MSG:", JSON.stringify({ document: rawMsg.document, photo: rawMsg.photo, voice: rawMsg.voice, caption: rawMsg.caption }).slice(0, 500));
    }

    const payload = webhookSchema.parse(request.body);
    const msg = payload.message;
    if (!msg) return reply.send({ ok: true, ignored: true });

    const chatId = String(msg.chat.id);
    let text = (msg.text ?? msg.caption ?? "").trim();

    // Handle file uploads — download and add path to context
    let filePath: string | null = null;
    if (msg.document) {
      filePath = await downloadTgFile(msg.document.file_id, msg.document.file_name);
    } else if (msg.photo?.length) {
      // Largest photo is last in array
      const largest = msg.photo[msg.photo.length - 1];
      filePath = await downloadTgFile(largest.file_id, `photo-${Date.now()}.jpg`);
    } else if (msg.voice) {
      filePath = await downloadTgFile(msg.voice.file_id, `voice-${Date.now()}.oga`);
    }

    // If file but no text, set a default prompt
    if (filePath && !text) {
      text = `Пользователь отправил файл: ${filePath}. Прочитай его и расскажи что в нём.`;
    } else if (filePath && text) {
      text = `Пользователь отправил файл: ${filePath}. Сообщение: ${text}`;
    }

    if (!text) return reply.send({ ok: true, ignored: true });

    // Classify
    const cls = classifyMessage(text);

    // Junk — ignore silently
    if (cls === "junk") {
      return reply.send({ ok: true, ignored: true });
    }

    // Banter — quick reply
    if (cls === "banter") {
      const replyText = BANTER_REPLIES[Math.floor(Math.random() * BANTER_REPLIES.length)];
      await tgSend(chatId, replyText);
      return reply.send({ ok: true, routed: "banter" });
    }

    // Command
    if (cls === "command") {
      const cmdReply = handleCommand(text, chatId);
      if (cmdReply) await tgSend(chatId, cmdReply);
      return reply.send({ ok: true, routed: "command" });
    }

    // Real question — call Claude
    // Send typing indicator immediately
    await tgTyping(chatId);
    // Don't await Claude — respond 200 to Telegram immediately, process async
    reply.send({ ok: true, routed: "claude" });

    // Process in background
    processQuestion(text, chatId).catch((err) => {
      console.error("Task failed:", err instanceof Error ? err.message : err);
      tgSend(chatId, "Ошибка обработки. Попробуй ещё раз.").catch(() => {});
    });

  } catch (err) {
    // Always return 200 to Telegram
    return reply.send({ ok: false, error: err instanceof Error ? err.message : "unknown" });
  }
});

const MEMORY_LOG = "/home/openclaw/mira-soul/memory/session-log.md";

function getRecentMemory(): string {
  try {
    if (!existsSync(MEMORY_LOG)) return "";
    const lines = readFileSync(MEMORY_LOG, "utf-8").trim().split("\n");
    // Last 20 entries
    const recent = lines.slice(-20).join("\n");
    return recent ? `\n\nНедавние события (помни это между сообщениями):\n${recent}\n` : "";
  } catch { return ""; }
}

function appendMemory(entry: string): void {
  try {
    const timestamp = new Date().toISOString().slice(0, 16);
    appendFileSync(MEMORY_LOG, `${timestamp} | ${entry.slice(0, 200)}\n`);
  } catch {}
}

async function processQuestion(question: string, chatId: string): Promise<void> {
  // Keep typing while Claude thinks
  const typingInterval = setInterval(() => tgTyping(chatId), 4000);

  try {
    // Add pinned facts + recent memory to context
    const facts = pinnedFacts.get(chatId);
    const memory = getRecentMemory();
    const contextPrefix = [
      facts?.length ? `Запомненные факты:\n${facts.map(f => `- ${f}`).join("\n")}` : "",
      memory,
      "ВАЖНО: Если тебе нужно что-то запомнить между сообщениями, напиши в конце ответа строку начинающуюся с [ЗАПОМНИТЬ]: и краткую заметку. Используй Baserow CRM для хранения данных (доступы в TOOLS.md). Для работы с n8n используй curl с API ключом из TOOLS.md.",
    ].filter(Boolean).join("\n\n") + "\n\n";

    console.log("CLAUDE CALL START:", question.slice(0, 80));
    const { text, cost, tokens } = await callClaude(`${contextPrefix}${question}`);
    console.log("CLAUDE CALL DONE:", text.length, "chars, $" + cost.toFixed(2), tokens, "tokens");

    clearInterval(typingInterval);

    if (!text) {
      await tgSend(chatId, "Не удалось получить ответ. Попробуй переформулировать.");
      return;
    }

    // Extract [ЗАПОМНИТЬ] entries and save to memory log
    const memoryMatches = text.match(/\[ЗАПОМНИТЬ\]:?\s*(.+)/gi);
    if (memoryMatches) {
      for (const m of memoryMatches) {
        const entry = m.replace(/\[ЗАПОМНИТЬ\]:?\s*/i, "").trim();
        if (entry) appendMemory(entry);
      }
    }

    // Also save a brief of what was asked/answered
    appendMemory(`Q: ${question.slice(0, 80)} → A: ${text.slice(0, 80)}`);

    // Clean [ЗАПОМНИТЬ] lines from user-visible response
    const cleanText = text.replace(/\[ЗАПОМНИТЬ\]:?\s*.+/gi, "").trim();

    // Send answer + cost (split if too long for Telegram's 4096 char limit)
    const costLine = cost > 0 ? `\n\n_Стоимость: $${cost.toFixed(2)}_` : "";
    const fullText = cleanText + costLine;

    if (fullText.length <= 4000) {
      await tgSend(chatId, fullText);
    } else {
      // Split into chunks
      const chunks: string[] = [];
      let remaining = fullText;
      while (remaining.length > 0) {
        if (remaining.length <= 4000) {
          chunks.push(remaining);
          break;
        }
        // Find a good split point (newline near 4000)
        let splitAt = remaining.lastIndexOf("\n", 4000);
        if (splitAt < 2000) splitAt = 4000;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
      }
      for (const chunk of chunks) {
        await tgSend(chatId, chunk);
      }
    }

  } catch (err) {
    clearInterval(typingInterval);
    const msg = err instanceof Error ? err.message : "unknown error";
    await tgSend(chatId, `Ошибка: ${msg.slice(0, 100)}. Попробуй ещё раз.`);
  }
}

// ============================================================
// Start
// ============================================================
app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`Simple bot listening on ${HOST}:${PORT}`);
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
