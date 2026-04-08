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
const SOUL_PATH = process.env.MIRA_SOUL_PATH ?? "/home/user/agent-soul/identity/FULL-CONTEXT.md";
const ADMIN_CHAT_ID = process.env.TELEGRAM_BOOTSTRAP_CHAT_ID ?? "";
const PORT = Number(process.env.API_PORT ?? 3000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const CLAUDE_TIMEOUT = 600_000; // 10 minutes max

// Vector memory (Pinecone + Cohere)
const PINECONE_API_KEY = process.env.PINECONE_API_KEY ?? "";
const PINECONE_HOST = process.env.PINECONE_HOST ?? "YOUR_PINECONE_HOST";
const COHERE_API_KEY = process.env.COHERE_API_KEY ?? "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

// Graph DB — Postgres connection for triples
const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agent_platform";

// ============================================================
// Telegram client (minimal)
// ============================================================
async function tgSend(chatId: string, text: string, threadId?: number): Promise<void> {
  if (!BOT_TOKEN) return;
  const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (threadId) payload.message_thread_id = threadId;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
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
// Vector Memory — embed & store, search & retrieve
// ============================================================
async function embedText(text: string): Promise<number[] | null> {
  if (!COHERE_API_KEY) return null;
  try {
    const res = await fetch("https://api.cohere.com/v1/embed", {
      method: "POST",
      headers: { "Authorization": `Bearer ${COHERE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        texts: [text.slice(0, 2000)],
        model: "embed-multilingual-v3.0",
        input_type: "search_document",
        truncate: "END"
      })
    });
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch (err) {
    console.error("EMBED ERROR:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function embedQuery(text: string): Promise<number[] | null> {
  if (!COHERE_API_KEY) return null;
  try {
    const res = await fetch("https://api.cohere.com/v1/embed", {
      method: "POST",
      headers: { "Authorization": `Bearer ${COHERE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        texts: [text.slice(0, 500)],
        model: "embed-multilingual-v3.0",
        input_type: "search_query",
        truncate: "END"
      })
    });
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch (err) {
    console.error("EMBED QUERY ERROR:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function storeMemory(text: string, metadata: Record<string, string>): Promise<void> {
  if (!PINECONE_API_KEY) return;
  const embedding = await embedText(text);
  if (!embedding) return;

  try {
    await fetch(`https://${PINECONE_HOST}/vectors/upsert`, {
      method: "POST",
      headers: { "Api-Key": PINECONE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: [{
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          values: embedding,
          metadata: { ...metadata, text: text.slice(0, 1000), timestamp: new Date().toISOString() }
        }]
      })
    });
    console.log("MEMORY STORED:", text.slice(0, 60));
  } catch (err) {
    console.error("PINECONE STORE ERROR:", err instanceof Error ? err.message : err);
  }
}

async function searchMemory(query: string, topK: number = 5): Promise<string[]> {
  if (!PINECONE_API_KEY) return [];
  const embedding = await embedQuery(query);
  if (!embedding) return [];

  try {
    const res = await fetch(`https://${PINECONE_HOST}/query`, {
      method: "POST",
      headers: { "Api-Key": PINECONE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: embedding,
        topK,
        includeMetadata: true
      })
    });
    const data = await res.json() as { matches?: Array<{ score: number; metadata?: { text?: string; timestamp?: string } }> };
    return (data.matches ?? [])
      .filter(m => m.score > 0.3)
      .map(m => `[${m.metadata?.timestamp?.slice(0, 16) ?? "?"}] ${m.metadata?.text ?? ""}`)
      .filter(Boolean);
  } catch (err) {
    console.error("PINECONE SEARCH ERROR:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ============================================================
// Knowledge Graph — extract triples, store, traverse
// ============================================================
import pg from "pg"; // will need: pnpm add pg @types/pg

let pgPool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new pg.Pool({ connectionString: DB_URL, max: 3 });
  }
  return pgPool;
}

async function initGraphTable(): Promise<void> {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS knowledge_triples (
        id SERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        source TEXT,
        confidence REAL DEFAULT 0.8,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_triples_subject ON knowledge_triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON knowledge_triples(object);
    `);
  } catch (err) {
    console.error("GRAPH TABLE INIT ERROR:", err instanceof Error ? err.message : err);
  }
}

async function extractAndStoreTriples(text: string, source: string): Promise<void> {
  if (!GROQ_API_KEY || text.length < 20) return;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You extract knowledge triples from text. Always return a JSON array of {subject, predicate, object}. Extract entities (people, projects, tools, companies) and their relationships. Never return empty array if text has entities." },
          { role: "user", content: `Text: "${text.slice(0, 1000)}"\n\nTriples:` }
        ],
        max_tokens: 500,
        temperature: 0.1
      })
    });

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";

    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const triples = JSON.parse(jsonMatch[0]) as Array<{ subject: string; predicate: string; object: string }>;
    if (!Array.isArray(triples) || triples.length === 0) return;

    const pool = getPool();
    for (const t of triples.slice(0, 10)) {
      if (t.subject && t.predicate && t.object) {
        await pool.query(
          "INSERT INTO knowledge_triples (subject, predicate, object, source) VALUES ($1, $2, $3, $4) ON CONFLICT (subject, predicate, object) DO NOTHING",
          [t.subject.toLowerCase().trim(), t.predicate.toLowerCase().trim(), t.object.toLowerCase().trim(), source]
        );
      }
    }
    console.log("GRAPH:", triples.length, "triples extracted from:", text.slice(0, 40));

  } catch (err) {
    console.error("GRAPH EXTRACT ERROR:", err instanceof Error ? err.message : err);
  }
}

async function queryGraph(query: string, hops: number = 2): Promise<string[]> {
  try {
    const pool = getPool();
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (keywords.length === 0) return [];

    // Find entities matching the query
    const likeConditions = keywords.map((_, i) => `(subject LIKE $${i + 1} OR object LIKE $${i + 1})`).join(" OR ");
    const likeParams = keywords.map(k => `%${k}%`);

    // 1-hop: direct connections
    const hop1 = await pool.query(
      `SELECT DISTINCT subject, predicate, object FROM knowledge_triples WHERE ${likeConditions} LIMIT 15`,
      likeParams
    );

    if (hop1.rows.length === 0) return [];

    // 2-hop: connections of connections
    const entities = new Set<string>();
    const results: string[] = [];
    for (const row of hop1.rows) {
      entities.add(row.subject);
      entities.add(row.object);
      results.push(`${row.subject} → ${row.predicate} → ${row.object}`);
    }

    if (hops >= 2 && entities.size > 0) {
      const entityList = Array.from(entities).slice(0, 10);
      const placeholders = entityList.map((_, i) => `$${i + 1}`).join(",");
      const hop2 = await pool.query(
        `SELECT DISTINCT subject, predicate, object FROM knowledge_triples
         WHERE (subject IN (${placeholders}) OR object IN (${placeholders}))
         AND id NOT IN (SELECT id FROM knowledge_triples WHERE ${likeConditions.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + entityList.length}`)})
         LIMIT 15`,
        [...entityList, ...likeParams]
      );
      for (const row of hop2.rows) {
        results.push(`${row.subject} → ${row.predicate} → ${row.object}`);
      }
    }

    return results;
  } catch (err) {
    console.error("GRAPH QUERY ERROR:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ============================================================
// Email — direct SMTP send
// ============================================================
const SMTP_USER = process.env.SMTP_USER ?? "agent.wmz.00@gmail.com";
const SMTP_PASS = process.env.SMTP_PASS ?? "";

async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (!SMTP_PASS) {
    console.error("SMTP_PASS not set");
    return false;
  }
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    await transport.sendMail({
      from: `Assistant <${SMTP_USER}>`,
      to, subject, text: body
    });
    console.log("EMAIL SENT:", to, subject.slice(0, 50));
    return true;
  } catch (err) {
    console.error("EMAIL ERROR:", err instanceof Error ? err.message : err);
    return false;
  }
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
      "--add-dir", "/home/user/agent-soul",
      "--add-dir", "/home/user/workspace",
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

const WELCOME_TEXT = `Привет! Я Ассистент — AI-ассистент.

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
    case "/email": {
      // /email to@addr.com Subject line | Body text
      const parts = rest.split("|").map(s => s.trim());
      if (parts.length < 2) return "Формат: /email адрес Тема | Текст письма";
      const firstSpace = parts[0].indexOf(" ");
      if (firstSpace < 0) return "Формат: /email адрес Тема | Текст письма";
      const emailTo = parts[0].slice(0, firstSpace).trim();
      const emailSubject = parts[0].slice(firstSpace).trim();
      const emailBody = parts.slice(1).join("|").trim();
      sendEmail(emailTo, emailSubject, emailBody).then(ok => {
        tgSend(chatId, ok ? `✉️ Отправлено на ${emailTo}` : "❌ Ошибка отправки").catch(() => {});
      });
      return "📤 Отправляю...";
    }
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
    message_thread_id: z.number().optional(),
    is_topic_message: z.boolean().optional(),
    reply_to_message: z.object({
      forum_topic_created: z.object({ name: z.string() }).optional(),
    }).passthrough().optional(),
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
    const threadId = msg.message_thread_id;
    let text = (msg.text ?? msg.caption ?? "").trim();

    // If it's a forum topic, add topic context to the message
    if (threadId) {
      text = `[Тема/топик #${threadId}] ${text}`;
    }

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

    // Banter — quick reply (still store in vector memory for pattern recognition)
    if (cls === "banter") {
      const replyText = BANTER_REPLIES[Math.floor(Math.random() * BANTER_REPLIES.length)];
      await tgSend(chatId, replyText, threadId);
      storeMemory(text, { type: "banter", chatId }).catch(() => {});
      return reply.send({ ok: true, routed: "banter" });
    }

    // Command
    if (cls === "command") {
      const cmdReply = handleCommand(text, chatId);
      if (cmdReply) await tgSend(chatId, cmdReply, threadId);
      return reply.send({ ok: true, routed: "command" });
    }

    // Real question — store in vector memory, then call Claude
    // Send typing indicator immediately
    await tgTyping(chatId);
    // Don't await Claude — respond 200 to Telegram immediately, process async
    reply.send({ ok: true, routed: "claude" });

    // Store user message in vector DB + extract graph triples (async, don't block)
    storeMemory(text, { type: "user_message", chatId, user: String(msg.from.id) }).catch(() => {});
    extractAndStoreTriples(text, `telegram:${msg.from.id}`).catch(() => {});

    // Process in background
    processQuestion(text, chatId, threadId).catch((err) => {
      console.error("Task failed:", err instanceof Error ? err.message : err);
      tgSend(chatId, "Ошибка обработки. Попробуй ещё раз.", threadId).catch(() => {});
    });

  } catch (err) {
    // Always return 200 to Telegram
    return reply.send({ ok: false, error: err instanceof Error ? err.message : "unknown" });
  }
});

const MEMORY_LOG = "/home/user/agent-soul/memory/session-log.md";

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

async function processQuestion(question: string, chatId: string, threadId?: number): Promise<void> {
  // Keep typing while Claude thinks
  const typingInterval = setInterval(() => tgTyping(chatId), 4000);

  try {
    // Search vector memory for similar context
    const vectorResults = await searchMemory(question);
    const vectorContext = vectorResults.length > 0
      ? `Релевантный контекст (похожие сообщения):\n${vectorResults.map(r => `- ${r}`).join("\n")}`
      : "";

    // Search knowledge graph for connected context
    const graphResults = await queryGraph(question);
    const graphContext = graphResults.length > 0
      ? `Связи из графа знаний:\n${graphResults.map(r => `- ${r}`).join("\n")}`
      : "";

    // Add pinned facts + vector memory + session log to context
    const facts = pinnedFacts.get(chatId);
    const memory = getRecentMemory();
    const contextPrefix = [
      vectorContext,
      graphContext,
      facts?.length ? `Запомненные факты:\n${facts.map(f => `- ${f}`).join("\n")}` : "",
      memory,
      "ВАЖНО: Если тебе нужно что-то запомнить между сообщениями, напиши в конце ответа строку начинающуюся с [ЗАПОМНИТЬ]: и краткую заметку. Используй Baserow CRM для хранения данных (доступы в TOOLS.md). Для работы с n8n используй curl с API ключом из TOOLS.md.",
    ].filter(Boolean).join("\n\n") + "\n\n";

    console.log("CLAUDE CALL START:", question.slice(0, 80));
    const { text, cost, tokens } = await callClaude(`${contextPrefix}${question}`);
    console.log("CLAUDE CALL DONE:", text.length, "chars, $" + cost.toFixed(2), tokens, "tokens");

    clearInterval(typingInterval);

    if (!text) {
      await tgSend(chatId, "Не удалось получить ответ. Попробуй переформулировать.", threadId);
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

    // Store Assistant's response in vector memory + extract triples
    storeMemory(`Q: ${question}\nA: ${text.slice(0, 500)}`, { type: "qa_pair", chatId }).catch(() => {});
    extractAndStoreTriples(text.slice(0, 1000), `agent:response`).catch(() => {});

    // Clean [ЗАПОМНИТЬ] lines from user-visible response
    const cleanText = text.replace(/\[ЗАПОМНИТЬ\]:?\s*.+/gi, "").trim();

    // Send answer + cost (split if too long for Telegram's 4096 char limit)
    const costLine = cost > 0 ? `\n\n_Стоимость: $${cost.toFixed(2)}_` : "";
    const fullText = cleanText + costLine;

    if (fullText.length <= 4000) {
      await tgSend(chatId, fullText, threadId);
    } else {
      const chunks: string[] = [];
      let remaining = fullText;
      while (remaining.length > 0) {
        if (remaining.length <= 4000) {
          chunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf("\n", 4000);
        if (splitAt < 2000) splitAt = 4000;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
      }
      for (const chunk of chunks) {
        await tgSend(chatId, chunk, threadId);
      }
    }

  } catch (err) {
    clearInterval(typingInterval);
    const msg = err instanceof Error ? err.message : "unknown error";
    await tgSend(chatId, `Ошибка: ${msg.slice(0, 100)}. Попробуй ещё раз.`, threadId);
  }
}

// ============================================================
// Start
// ============================================================
// Init graph table on startup
initGraphTable().then(() => console.log("Knowledge graph table ready")).catch(() => {});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`Simple bot listening on ${HOST}:${PORT}`);
}).catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
