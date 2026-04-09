import { randomUUID } from "node:crypto";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync as fsWriteFile, appendFileSync, existsSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";
import pg from "pg";

// ============================================================
// Config — only TELEGRAM + CLAUDE required, everything else optional
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CLAUDE_PATH = process.env.CLAUDE_CODE_PATH ?? "claude";
const SOUL_PATH = process.env.MIRA_SOUL_PATH ?? "/opt/agent-platform/agent-soul/FULL-CONTEXT.md";
const PORT = Number(process.env.API_PORT ?? 3000);
const HOST = process.env.API_HOST ?? "0.0.0.0";
const CLAUDE_TIMEOUT = 1_800_000; // 30 min for complex multi-step tasks
const MAX_PROMPT_LENGTH = 30_000; // truncate huge messages to avoid timeouts
const MAX_CONCURRENT_CLAUDE = 2; // max parallel Claude processes
const HEARTBEAT_INTERVAL = 120_000; // 2 min progress updates to user
const SIGKILL_GRACE = 10_000; // 10s after SIGTERM before SIGKILL

// Optional: Vector memory
const PINECONE_API_KEY = process.env.PINECONE_API_KEY ?? "";
const PINECONE_HOST = process.env.PINECONE_HOST ?? "";
const COHERE_API_KEY = process.env.COHERE_API_KEY ?? "";

// Optional: Knowledge graph
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

// Optional: Email
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASS = process.env.SMTP_PASS ?? "";

// Database — always available (comes with docker-compose)
const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/agent_platform";

// Feature flags — auto-detected from config
const HAS_VECTOR = !!(PINECONE_API_KEY && PINECONE_HOST && COHERE_API_KEY);
const HAS_GRAPH = !!GROQ_API_KEY;
const HAS_EMAIL = !!(SMTP_USER && SMTP_PASS);

console.log(`Features: vector=${HAS_VECTOR} graph=${HAS_GRAPH} email=${HAS_EMAIL}`);

// ============================================================
// Database — Postgres (always available)
// ============================================================
let pgPool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pgPool) pgPool = new pg.Pool({ connectionString: DB_URL, max: 3 });
  return pgPool;
}

async function initDB(): Promise<void> {
  try {
    const pool = getPool();
    // Memory table — full-text search (always available, no extensions needed)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        type TEXT DEFAULT 'message',
        chat_id TEXT,
        user_id TEXT,
        ts TIMESTAMPTZ DEFAULT NOW(),
        tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_memories_tsv ON memories USING GIN(tsv);
      CREATE INDEX IF NOT EXISTS idx_memories_ts ON memories(ts DESC);
    `);
    // Knowledge graph table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_triples (
        id SERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        source TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_triples_unique
        ON knowledge_triples(subject, predicate, object);
      CREATE INDEX IF NOT EXISTS idx_triples_subject ON knowledge_triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON knowledge_triples(object);
    `);
    console.log("Database tables ready");
  } catch (err) {
    console.error("DB INIT:", err instanceof Error ? err.message : err);
  }
}

// ============================================================
// Memory — Postgres full-text search (always works, no API keys)
// ============================================================
async function storeMemoryDB(text: string, type: string, chatId: string, userId?: string): Promise<void> {
  try {
    await getPool().query(
      "INSERT INTO memories (text, type, chat_id, user_id) VALUES ($1, $2, $3, $4)",
      [text.slice(0, 8000), type, chatId, userId ?? null]
    );
  } catch {}
}

async function searchMemoryDB(query: string, limit: number = 5): Promise<string[]> {
  try {
    const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 10);
    if (words.length === 0) return [];
    const tsQuery = words.join(" | ");
    const res = await getPool().query(
      `SELECT text, ts_rank(tsv, to_tsquery('simple', $1)) as rank
       FROM memories WHERE tsv @@ to_tsquery('simple', $1)
       ORDER BY rank DESC, ts DESC LIMIT $2`,
      [tsQuery, limit]
    );
    return res.rows.map((r: { text: string; rank: number }) => r.text);
  } catch { return []; }
}

// ============================================================
// Optional: Vector memory (Pinecone + Cohere)
// ============================================================
async function embedText(text: string, inputType: string): Promise<number[] | null> {
  if (!HAS_VECTOR) return null;
  try {
    const res = await fetch("https://api.cohere.com/v1/embed", {
      method: "POST",
      headers: { "Authorization": `Bearer ${COHERE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ texts: [text.slice(0, 2000)], model: "embed-multilingual-v3.0", input_type: inputType, truncate: "END" })
    });
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch { return null; }
}

async function storeVector(text: string, metadata: Record<string, string>): Promise<void> {
  if (!HAS_VECTOR) return;
  const embedding = await embedText(text, "search_document");
  if (!embedding) return;
  try {
    await fetch(`https://${PINECONE_HOST}/vectors/upsert`, {
      method: "POST",
      headers: { "Api-Key": PINECONE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ vectors: [{ id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, values: embedding, metadata: { ...metadata, text: text.slice(0, 4000), timestamp: new Date().toISOString() } }] })
    });
  } catch {}
}

async function searchVector(query: string, topK: number = 5): Promise<string[]> {
  if (!HAS_VECTOR) return [];
  const embedding = await embedText(query, "search_query");
  if (!embedding) return [];
  try {
    const res = await fetch(`https://${PINECONE_HOST}/query`, {
      method: "POST",
      headers: { "Api-Key": PINECONE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ vector: embedding, topK, includeMetadata: true })
    });
    const data = await res.json() as { matches?: Array<{ score: number; metadata?: { text?: string } }> };
    return (data.matches ?? []).filter(m => m.score > 0.3).map(m => m.metadata?.text ?? "").filter(Boolean);
  } catch { return []; }
}

// ============================================================
// Optional: Knowledge graph (Groq + Postgres)
// ============================================================
async function extractTriples(text: string, source: string): Promise<void> {
  if (!HAS_GRAPH || text.length < 20) return;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "Extract knowledge triples from text. Return ONLY a JSON array of {subject, predicate, object}. Never return empty if entities exist." },
          { role: "user", content: `Text: "${text.slice(0, 1000)}"\n\nTriples:` }
        ],
        max_tokens: 500, temperature: 0.1
      })
    });
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;
    const triples = JSON.parse(jsonMatch[0]) as Array<{ subject: string; predicate: string; object: string }>;
    const pool = getPool();
    for (const t of triples.slice(0, 10)) {
      if (t.subject && t.predicate && t.object) {
        await pool.query("INSERT INTO knowledge_triples (subject, predicate, object, source) VALUES ($1, $2, $3, $4) ON CONFLICT (subject, predicate, object) DO NOTHING",
          [t.subject.toLowerCase().trim(), t.predicate.toLowerCase().trim(), t.object.toLowerCase().trim(), source]);
      }
    }
  } catch {}
}

async function queryGraph(query: string): Promise<string[]> {
  try {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (words.length === 0) return [];
    const conds = words.map((_, i) => `(t.subject LIKE $${i+1} OR t.object LIKE $${i+1})`).join(" OR ");
    const params = words.map(w => `%${w}%`);
    // 2-hop recursive CTE: find direct matches, then follow connections one more hop
    const res = await getPool().query(`
      WITH RECURSIVE graph AS (
        SELECT subject, predicate, object, 1 AS depth
        FROM knowledge_triples t WHERE ${conds}
        UNION
        SELECT t2.subject, t2.predicate, t2.object, g.depth + 1
        FROM knowledge_triples t2
        JOIN graph g ON (t2.subject = g.object OR t2.subject = g.subject
                        OR t2.object = g.subject OR t2.object = g.object)
        WHERE g.depth < 2
      )
      SELECT DISTINCT subject, predicate, object, depth
      FROM graph ORDER BY depth, subject LIMIT 15
    `, params);
    return res.rows.map((r: { subject: string; predicate: string; object: string; depth: number }) =>
      `${r.subject} → ${r.predicate} → ${r.object}${r.depth > 1 ? " (связь)" : ""}`);
  } catch { return []; }
}

// ============================================================
// Session log — simple file-based recent memory (always works)
// ============================================================
const SESSION_LOG = process.env.SESSION_LOG_PATH ?? "/home/openclaw/mira-soul/memory/session-log.md";

function appendSessionLog(entry: string): void {
  try {
    const ts = new Date().toISOString().slice(0, 16);
    appendFileSync(SESSION_LOG, `${ts} | ${entry.slice(0, 200)}\n`);
  } catch {}
}

function getRecentSession(): string {
  try {
    if (!existsSync(SESSION_LOG)) return "";
    const lines = readFileSync(SESSION_LOG, "utf-8").trim().split("\n");
    const recent = lines.slice(-20).join("\n");
    return recent ? `\nПоследние события:\n${recent}\n` : "";
  } catch { return ""; }
}

// ============================================================
// Unified memory: store + search (auto-picks available backends)
// ============================================================
async function rememberMessage(text: string, chatId: string, userId?: string): Promise<void> {
  storeMemoryDB(text, "message", chatId, userId).catch(() => {});
  storeVector(text, { type: "message", chatId }).catch(() => {});
  extractTriples(text, `user:${userId ?? "unknown"}`).catch(() => {});
  appendSessionLog(text.slice(0, 200));
}

async function recallContext(query: string): Promise<string> {
  const parts: string[] = [];

  // Postgres full-text (always available) — full text, no truncation
  const dbResults = await searchMemoryDB(query);
  if (dbResults.length > 0) parts.push(`Релевантные записи из памяти:\n${dbResults.join("\n---\n")}`);

  // Vector search (if configured) — full text
  const vecResults = await searchVector(query);
  if (vecResults.length > 0) parts.push(`Семантически похожее:\n${vecResults.join("\n---\n")}`);

  // Graph (if configured)
  const graphResults = await queryGraph(query);
  if (graphResults.length > 0) parts.push(`Связи:\n${graphResults.map(r => `- ${r}`).join("\n")}`);

  // Tell Claude how to dig deeper if the auto-recall isn't enough
  parts.push(`Если нужно больше контекста — ты можешь сама:
- psql: docker exec $(docker ps -q -f name=postgres) psql -U postgres -d agent_platform -c "SELECT text FROM memories WHERE text LIKE '%keyword%' ORDER BY ts DESC LIMIT 5;"
- Файлы: grep -r 'keyword' /home/openclaw/mira-soul/memory/
- Сессии: cat /home/openclaw/mira-soul/memory/session-log.md | tail -50`);

  return parts.join("\n\n");
}

// ============================================================
// Telegram
// ============================================================
async function tgSend(chatId: string, text: string, threadId?: number): Promise<void> {
  if (!BOT_TOKEN) return;
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId) payload.message_thread_id = threadId;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, parse_mode: "Markdown" })
  }).catch(() => null);
  const data = res ? await res.json().catch(() => null) as { ok?: boolean } | null : null;
  if (!data?.ok) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).catch((err) => console.error("TG SEND FAILED:", err instanceof Error ? err.message : err));
  }
}

async function tgTyping(chatId: string): Promise<void> {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: "POST", headers: { "content-type": "application/json" },
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

function classify(text: string): "banter" | "junk" | "command" | "real" {
  const t = text.trim();
  if (!t || t.length < 2) return "junk";
  if (JUNK_RE.test(t)) return "junk";
  if (GREETING_RE.test(t) || BANTER_RE.test(t)) return "banter";
  if (t.startsWith("/")) return "command";
  return "real";
}

// ============================================================
// Task queue — concurrency limiter + per-chat dedup
// ============================================================
interface ActiveTask {
  chatId: string;
  threadId?: number;
  prompt: string;
  startedAt: number;
  child: ChildProcess | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  followUps: string[]; // messages that arrived while this task was running
}

const activeTasks = new Map<string, ActiveTask>(); // key = chatId:threadId
let runningCount = 0;

interface QueueItem {
  chatId: string;
  threadId?: number;
  prompt: string;
  userId?: string;
  resolve: () => void;
}
const taskQueue: QueueItem[] = [];

function taskKey(chatId: string, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

function drainQueue(): void {
  while (runningCount < MAX_CONCURRENT_CLAUDE && taskQueue.length > 0) {
    const item = taskQueue.shift()!;
    runningCount++;
    processQuestion(item.prompt, item.chatId, item.threadId).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("FAILED:", errMsg);
      const isTimeout = errMsg.includes("timeout");
      const userMsg = isTimeout
        ? `⏱ Таймаут — Claude не уложился в ${Math.round(CLAUDE_TIMEOUT / 60000)} мин. Попробуй короче или разбей на части.`
        : `❌ Ошибка: ${errMsg.slice(0, 200)}. Попробуй ещё раз.`;
      tgSend(item.chatId, userMsg, item.threadId);
    }).finally(() => {
      runningCount--;
      item.resolve();
      drainQueue();
    });
  }
}

function enqueueTask(chatId: string, prompt: string, threadId?: number, userId?: string): void {
  const key = taskKey(chatId, threadId);
  const existing = activeTasks.get(key);

  // Per-chat dedup: if Claude is already working for this chat/thread, queue as follow-up
  if (existing) {
    existing.followUps.push(prompt);
    const elapsed = Math.round((Date.now() - existing.startedAt) / 60000);
    tgSend(chatId, `📎 Добавила к текущей задаче (работаю уже ${elapsed} мин). Отвечу на всё вместе.`, threadId);
    return;
  }

  if (runningCount >= MAX_CONCURRENT_CLAUDE) {
    const pos = taskQueue.length + 1;
    tgSend(chatId, `⏳ Принято. Ты #${pos} в очереди, сейчас обрабатываю ${runningCount} задач.`, threadId);
  } else {
    tgSend(chatId, "⏳ Принято, работаю...", threadId);
  }

  rememberMessage(prompt, chatId, userId).catch(() => {});
  new Promise<void>(resolve => {
    taskQueue.push({ chatId, threadId, prompt, userId, resolve });
    drainQueue();
  });
}

// ============================================================
// Claude CLI
// ============================================================
function callClaude(prompt: string, task?: ActiveTask): Promise<{ text: string; cost: number; tokens: number }> {
  // Truncate excessively long prompts to avoid timeouts
  const truncated = prompt.length > MAX_PROMPT_LENGTH
    ? prompt.slice(0, MAX_PROMPT_LENGTH) + "\n\n[...сообщение обрезано, было " + prompt.length + " символов]"
    : prompt;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const args = ["-p", truncated, "--output-format", "json", "--no-session-persistence",
      "--dangerously-skip-permissions", "--max-turns", "50"];
    try { readFileSync(SOUL_PATH); args.push("--system-prompt-file", SOUL_PATH); } catch {}

    const startTime = Date.now();
    const child = spawn(CLAUDE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (task) task.child = child;
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const forceKill = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
          // Belt-and-suspenders: also kill by PID in case node handle is stale
          if (child.pid) try { process.kill(child.pid, "SIGKILL"); } catch {}
        } catch {}
      }, SIGKILL_GRACE);
    };

    const timer = setTimeout(() => {
      forceKill();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      // Try to salvage partial output
      let partial = "";
      try {
        const env = JSON.parse(stdout.trim());
        partial = env.result ?? "";
      } catch {}
      settle(() => reject(new Error(`Claude timeout (${elapsed}s)${partial ? `\n\nЧастичный ответ:\n${partial.slice(0, 500)}` : ""}`)));
    }, CLAUDE_TIMEOUT);

    child.on("close", () => {
      clearTimeout(timer);
      if (task) task.child = null;
      settle(() => {
        try {
          const env = JSON.parse(stdout.trim());
          resolve({ text: env.result ?? "", cost: env.total_cost_usd ?? 0,
            tokens: (env.usage?.input_tokens ?? 0) + (env.usage?.output_tokens ?? 0) });
        } catch { reject(new Error(stderr.trim() || "No output from Claude")); }
      });
    });
    child.on("error", (err) => { clearTimeout(timer); settle(() => reject(err)); });
  });
}

// ============================================================
// Commands
// ============================================================
const HELP = `Команды:
/start — приветствие
/help — список команд
/status — что сейчас делаю
/pin <факт> — запомнить факт
${HAS_EMAIL ? "/email to Subject | Body — отправить письмо\n" : ""}/cost — стоимость`;

const pinnedFacts: Map<string, string[]> = new Map();

function handleCommand(text: string, chatId: string): string | null {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const rest = text.slice(cmd.length).trim();
  switch (cmd) {
    case "/start": return `Привет! Я AI-ассистент.\n\n${HELP}\n\nИли просто напиши вопрос.`;
    case "/help": return HELP;
    case "/pin": {
      if (!rest) return "Формат: /pin <факт>";
      const f = pinnedFacts.get(chatId) ?? [];
      f.push(rest); pinnedFacts.set(chatId, f);
      storeMemoryDB(`PINNED: ${rest}`, "pin", chatId).catch(() => {});
      return `📌 Запомнила: ${rest}`;
    }
    case "/email": {
      if (!HAS_EMAIL) return "Email не настроен. Добавьте SMTP_USER и SMTP_PASS в .env";
      const parts = rest.split("|").map(s => s.trim());
      if (parts.length < 2) return "Формат: /email адрес Тема | Текст";
      const sp = parts[0].indexOf(" ");
      if (sp < 0) return "Формат: /email адрес Тема | Текст";
      import("nodemailer").then(nm => {
        const t = nm.createTransport({ host: "smtp.gmail.com", port: 587, secure: false, auth: { user: SMTP_USER, pass: SMTP_PASS } });
        t.sendMail({ from: SMTP_USER, to: parts[0].slice(0, sp), subject: parts[0].slice(sp).trim(), text: parts.slice(1).join("|") })
          .then(() => tgSend(chatId, "✉️ Отправлено"))
          .catch(() => tgSend(chatId, "❌ Ошибка отправки"));
      });
      return "📤 Отправляю...";
    }
    case "/status": {
      if (activeTasks.size === 0 && taskQueue.length === 0) return "💤 Свободна, жду задач.";
      const lines: string[] = [];
      for (const [k, t] of activeTasks) {
        const elapsed = Math.round((Date.now() - t.startedAt) / 60000);
        lines.push(`🔄 ${t.prompt.slice(0, 60)}... (${elapsed} мин)`);
        if (t.followUps.length > 0) lines.push(`  📎 +${t.followUps.length} доп. сообщений в очереди`);
      }
      if (taskQueue.length > 0) lines.push(`⏳ В очереди: ${taskQueue.length}`);
      lines.push(`\nClaude процессов: ${runningCount}/${MAX_CONCURRENT_CLAUDE}`);
      return lines.join("\n");
    }
    case "/cost": return "📊 Простой вопрос ~$0.04, сложный ~$0.15-0.50";
    default: return null;
  }
}

// ============================================================
// File handling
// ============================================================
async function downloadFile(fileId: string, filename?: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const data = await res.json() as { ok: boolean; result?: { file_path: string } };
    if (!data.ok || !data.result?.file_path) return null;
    const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`)).arrayBuffer());
    const ext = data.result.file_path.split(".").pop() ?? "bin";
    const path = `/tmp/tg-${Date.now()}.${ext}`;
    fsWriteFile(path, buf);
    if (ext === "docx" || ext === "doc") {
      try { const txt = path.replace(/\.(docx?)$/i, ".txt"); execSync(`pandoc "${path}" -t plain -o "${txt}"`, { timeout: 10000 }); return txt; } catch {}
    }
    return path;
  } catch { return null; }
}

// ============================================================
// Webhook
// ============================================================
const schema = z.object({
  update_id: z.number(),
  message: z.object({
    message_id: z.number(),
    text: z.string().optional(),
    caption: z.string().optional(),
    chat: z.object({ id: z.number() }).passthrough(),
    from: z.object({ id: z.number(), username: z.string().optional(), first_name: z.string().optional() }).passthrough(),
    document: z.object({ file_id: z.string(), file_name: z.string().optional() }).passthrough().optional(),
    photo: z.array(z.object({ file_id: z.string() }).passthrough()).optional(),
    voice: z.object({ file_id: z.string() }).passthrough().optional(),
    message_thread_id: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

const app = Fastify({ logger: false });
app.get("/health", async () => ({
  ok: true,
  features: { vector: HAS_VECTOR, graph: HAS_GRAPH, email: HAS_EMAIL },
  tasks: { active: activeTasks.size, queued: taskQueue.length, running: runningCount, max: MAX_CONCURRENT_CLAUDE },
  uptime: Math.round(process.uptime()),
  now: new Date().toISOString(),
}));

app.post("/webhooks/telegram", async (request, reply) => {
  try {
    const p = schema.parse(request.body);
    const msg = p.message;
    if (!msg) return reply.send({ ok: true });
    const chatId = String(msg.chat.id);
    const threadId = msg.message_thread_id;
    let text = (msg.text ?? msg.caption ?? "").trim();

    // Files
    let filePath: string | null = null;
    if (msg.document) filePath = await downloadFile(msg.document.file_id, msg.document.file_name);
    else if (msg.photo?.length) filePath = await downloadFile(msg.photo[msg.photo.length - 1].file_id);
    else if (msg.voice) filePath = await downloadFile(msg.voice.file_id);
    if (filePath && !text) text = `Пользователь отправил файл: ${filePath}. Прочитай и расскажи.`;
    else if (filePath) text = `Файл: ${filePath}. ${text}`;
    if (threadId) text = `[Топик #${threadId}] ${text}`;
    if (!text) return reply.send({ ok: true });

    const cls = classify(text);
    if (cls === "junk") return reply.send({ ok: true });
    if (cls === "banter") { await tgSend(chatId, BANTER_REPLIES[Math.floor(Math.random() * BANTER_REPLIES.length)], threadId); rememberMessage(text, chatId); return reply.send({ ok: true }); }
    if (cls === "command") { const r = handleCommand(text, chatId); if (r) await tgSend(chatId, r, threadId); return reply.send({ ok: true }); }

    // Real question — enqueue with concurrency control
    if (shuttingDown) {
      await tgSend(chatId, "🔄 Перезапускаюсь, отправь через 30 секунд.", threadId);
      return reply.send({ ok: true });
    }
    reply.send({ ok: true });
    enqueueTask(chatId, text, threadId, String(msg.from.id));
  } catch (err) { return reply.send({ ok: false, error: err instanceof Error ? err.message : "error" }); }
});

async function processQuestion(q: string, chatId: string, threadId?: number): Promise<void> {
  const key = taskKey(chatId, threadId);
  const task: ActiveTask = {
    chatId, threadId, prompt: q, startedAt: Date.now(),
    child: null, heartbeat: null, followUps: [],
  };
  activeTasks.set(key, task);

  const typing = setInterval(() => tgTyping(chatId), 4000);

  // Heartbeat: tell user we're still alive every 2 min
  task.heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - task.startedAt) / 60000);
    tgSend(chatId, `⚙️ Всё ещё работаю... (${elapsed} мин)`, threadId);
  }, HEARTBEAT_INTERVAL);

  try {
    const context = await recallContext(q);
    const session = getRecentSession();
    const facts = pinnedFacts.get(chatId);
    const prefix = [context, session, facts?.length ? `Факты:\n${facts.map(f => `- ${f}`).join("\n")}` : ""].filter(Boolean).join("\n\n");

    console.log("CLAUDE:", q.slice(0, 60));
    const { text, cost } = await callClaude(prefix ? `${prefix}\n\n${q}` : q, task);
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    console.log(`DONE: ${text.length} chars $${cost.toFixed(2)} ${elapsed}s`);
    clearInterval(typing);
    clearInterval(task.heartbeat);

    if (!text) { await tgSend(chatId, "Нет ответа. Переформулируй.", threadId); return; }

    // Store response in all memory layers
    storeMemoryDB(`Q: ${q.slice(0, 500)}\nA: ${text.slice(0, 4000)}`, "qa", chatId).catch(() => {});
    storeVector(`Q: ${q.slice(0, 500)}\nA: ${text.slice(0, 2000)}`, { type: "qa", chatId }).catch(() => {});
    extractTriples(text.slice(0, 2000), "assistant").catch(() => {});
    appendSessionLog(`Q: ${q.slice(0, 150)} → A: ${text.slice(0, 150)}`);

    const full = text + (cost > 0 ? `\n\n_Стоимость: $${cost.toFixed(2)}_` : "");
    await sendLong(chatId, full, threadId);

    // Process follow-up messages that arrived while we were working
    if (task.followUps.length > 0) {
      const followUp = task.followUps.map((f, i) => `[Доп. сообщение ${i + 1}]: ${f}`).join("\n");
      console.log(`FOLLOW-UP: ${task.followUps.length} messages for ${key}`);
      activeTasks.delete(key);
      // Re-enqueue combined follow-ups as a new task
      enqueueTask(chatId, `Контекст предыдущего ответа: ${text.slice(0, 3000)}\n\n${followUp}`, threadId);
    } else {
      activeTasks.delete(key);
    }
  } catch (err) {
    clearInterval(typing);
    if (task.heartbeat) clearInterval(task.heartbeat);
    activeTasks.delete(key);
    throw err;
  }
}

async function sendLong(chatId: string, text: string, threadId?: number): Promise<void> {
  if (text.length <= 4000) { await tgSend(chatId, text, threadId); return; }
  let rem = text;
  while (rem.length > 0) {
    const cut = rem.length <= 4000 ? rem.length : (rem.lastIndexOf("\n", 4000) > 2000 ? rem.lastIndexOf("\n", 4000) : 4000);
    await tgSend(chatId, rem.slice(0, cut), threadId);
    rem = rem.slice(cut);
  }
}

// ============================================================
// Stale task reaper — runs every 60s, kills tasks stuck past timeout
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [key, task] of activeTasks) {
    const elapsed = now - task.startedAt;
    if (elapsed > CLAUDE_TIMEOUT + 30_000) {
      // Task is stuck past timeout + grace period — force cleanup
      console.error(`REAPER: killing stale task ${key} (${Math.round(elapsed / 60000)} min)`);
      if (task.child) {
        try { task.child.kill("SIGKILL"); } catch {}
        if (task.child.pid) try { process.kill(task.child.pid, "SIGKILL"); } catch {}
      }
      if (task.heartbeat) clearInterval(task.heartbeat);
      tgSend(task.chatId, `⏱ Задача отменена (превышен лимит ${Math.round(CLAUDE_TIMEOUT / 60000)} мин). Попробуй разбить на части.`, task.threadId);
      activeTasks.delete(key);
      runningCount = Math.max(0, runningCount - 1);
      drainQueue();
    }
  }
}, 60_000);

// ============================================================
// Graceful shutdown — notify users, wait for tasks, then exit
// ============================================================
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`SHUTDOWN: ${signal} received, ${activeTasks.size} active tasks, ${taskQueue.length} queued`);

  // Notify queued task owners immediately
  for (const item of taskQueue) {
    tgSend(item.chatId, "🔄 Бот перезапускается. Отправь запрос ещё раз через 30 секунд.", item.threadId);
  }
  taskQueue.length = 0;

  if (activeTasks.size === 0) {
    process.exit(0);
    return;
  }

  // Give active tasks a grace period to finish (up to 60s)
  console.log(`SHUTDOWN: waiting up to 60s for ${activeTasks.size} active tasks...`);
  const deadline = Date.now() + 60_000;

  const checkDone = setInterval(() => {
    if (activeTasks.size === 0 || Date.now() > deadline) {
      clearInterval(checkDone);
      // Notify users of tasks we couldn't finish
      for (const [, task] of activeTasks) {
        if (task.heartbeat) clearInterval(task.heartbeat);
        const elapsed = Math.round((Date.now() - task.startedAt) / 60000);
        tgSend(task.chatId, `🔄 Бот перезапустился пока я работала (${elapsed} мин). Отправь запрос ещё раз.`, task.threadId);
      }
      setTimeout(() => process.exit(0), 2000); // 2s for messages to send
    }
  }, 1000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============================================================
// Start
// ============================================================
initDB();
app.listen({ port: PORT, host: HOST }).then(() => console.log(`Bot on ${HOST}:${PORT}`));
