import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
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
const CLAUDE_TIMEOUT = 600_000;

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
      [text.slice(0, 2000), type, chatId, userId ?? null]
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
      body: JSON.stringify({ vectors: [{ id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, values: embedding, metadata: { ...metadata, text: text.slice(0, 1000), timestamp: new Date().toISOString() } }] })
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
    const conds = words.map((_, i) => `(subject LIKE $${i+1} OR object LIKE $${i+1})`).join(" OR ");
    const params = words.map(w => `%${w}%`);
    const res = await getPool().query(`SELECT subject, predicate, object FROM knowledge_triples WHERE ${conds} LIMIT 10`, params);
    return res.rows.map((r: { subject: string; predicate: string; object: string }) => `${r.subject} → ${r.predicate} → ${r.object}`);
  } catch { return []; }
}

// ============================================================
// Session log — simple file-based recent memory (always works)
// ============================================================
const SESSION_LOG = process.env.SESSION_LOG_PATH ?? "/home/user/agent-soul/memory/session-log.md";

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

  // Postgres full-text (always available)
  const dbResults = await searchMemoryDB(query);
  if (dbResults.length > 0) parts.push(`Похожие сообщения:\n${dbResults.map(r => `- ${r.slice(0, 150)}`).join("\n")}`);

  // Vector search (if configured)
  const vecResults = await searchVector(query);
  if (vecResults.length > 0) parts.push(`Семантический контекст:\n${vecResults.map(r => `- ${r.slice(0, 150)}`).join("\n")}`);

  // Graph (if configured)
  const graphResults = await queryGraph(query);
  if (graphResults.length > 0) parts.push(`Связи:\n${graphResults.map(r => `- ${r}`).join("\n")}`);

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
// Claude CLI
// ============================================================
function callClaude(prompt: string): Promise<{ text: string; cost: number; tokens: number }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--no-session-persistence",
      "--dangerously-skip-permissions", "--max-turns", "50"];
    try { readFileSync(SOUL_PATH); args.push("--system-prompt-file", SOUL_PATH); } catch {}

    const child = spawn(CLAUDE_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude timeout")); }, CLAUDE_TIMEOUT);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(stdout.trim());
        resolve({ text: env.result ?? "", cost: env.total_cost_usd ?? 0,
          tokens: (env.usage?.input_tokens ?? 0) + (env.usage?.output_tokens ?? 0) });
      } catch { reject(new Error(stderr.trim() || "No output")); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ============================================================
// Commands
// ============================================================
const HELP = `Команды:
/start — приветствие
/help — список команд
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
app.get("/health", async () => ({ ok: true, features: { vector: HAS_VECTOR, graph: HAS_GRAPH, email: HAS_EMAIL }, now: new Date().toISOString() }));

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

    // Real question
    await tgSend(chatId, "⏳ Принято, работаю...", threadId);
    reply.send({ ok: true });

    rememberMessage(text, chatId, String(msg.from.id)).catch(() => {});
    processQuestion(text, chatId, threadId).catch(err => {
      console.error("FAILED:", err instanceof Error ? err.message : err);
      tgSend(chatId, "Ошибка. Попробуй ещё раз.", threadId);
    });
  } catch (err) { return reply.send({ ok: false, error: err instanceof Error ? err.message : "error" }); }
});

async function processQuestion(q: string, chatId: string, threadId?: number): Promise<void> {
  const typing = setInterval(() => tgTyping(chatId), 4000);
  try {
    const context = await recallContext(q);
    const session = getRecentSession();
    const facts = pinnedFacts.get(chatId);
    const prefix = [context, session, facts?.length ? `Факты:\n${facts.map(f => `- ${f}`).join("\n")}` : ""].filter(Boolean).join("\n\n");

    console.log("CLAUDE:", q.slice(0, 60));
    const { text, cost } = await callClaude(prefix ? `${prefix}\n\n${q}` : q);
    console.log("DONE:", text.length, "chars $" + cost.toFixed(2));
    clearInterval(typing);

    if (!text) { await tgSend(chatId, "Нет ответа. Переформулируй.", threadId); return; }

    // Store response in all memory layers
    storeMemoryDB(`Q: ${q.slice(0, 200)}\nA: ${text.slice(0, 500)}`, "qa", chatId).catch(() => {});
    storeVector(`Q: ${q}\nA: ${text.slice(0, 500)}`, { type: "qa", chatId }).catch(() => {});
    extractTriples(text.slice(0, 1000), "assistant").catch(() => {});
    appendSessionLog(`Q: ${q.slice(0, 80)} → A: ${text.slice(0, 80)}`);

    const full = text + (cost > 0 ? `\n\n_Стоимость: $${cost.toFixed(2)}_` : "");
    if (full.length <= 4000) { await tgSend(chatId, full, threadId); }
    else {
      let rem = full;
      while (rem.length > 0) {
        const cut = rem.length <= 4000 ? rem.length : (rem.lastIndexOf("\n", 4000) > 2000 ? rem.lastIndexOf("\n", 4000) : 4000);
        await tgSend(chatId, rem.slice(0, cut), threadId);
        rem = rem.slice(cut);
      }
    }
  } catch (err) { clearInterval(typing); throw err; }
}

// ============================================================
// Start
// ============================================================
initDB();
app.listen({ port: PORT, host: HOST }).then(() => console.log(`Bot on ${HOST}:${PORT}`));
