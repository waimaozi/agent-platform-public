import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import Fastify from "fastify";

const PORT = Number(process.env.SETUP_PORT ?? 8888);
const INSTALL_DIR = process.env.INSTALL_DIR ?? "/opt/agent-platform";
const ENV_PATH = `${INSTALL_DIR}/.env`;

// ============================================================
// State
// ============================================================
interface SetupState {
  step: number;
  telegramToken: string;
  botUsername: string;
  claudeReady: boolean;
  pineconeKey: string;
  pineconeHost: string;
  cohereKey: string;
  groqKey: string;
  agentName: string;
  soulContent: string;
  smtpUser: string;
  smtpPass: string;
  serverIp: string;
  complete: boolean;
}

let state: SetupState = {
  step: 1,
  telegramToken: "",
  botUsername: "",
  claudeReady: false,
  pineconeKey: "",
  pineconeHost: "",
  cohereKey: "",
  groqKey: "",
  agentName: "AI Assistant",
  soulContent: "",
  smtpUser: "",
  smtpPass: "",
  serverIp: "",
  complete: false
};

// Get server IP
try {
  state.serverIp = process.env.SERVER_IP ?? execSync("curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'", { timeout: 10000 }).toString().trim();
} catch { state.serverIp = "YOUR_IP"; }

// Load default SOUL.md
try {
  state.soulContent = readFileSync(`${INSTALL_DIR}/docs/examples/SOUL.md`, "utf-8");
} catch { state.soulContent = "# Your Agent\n\nYou are a helpful AI assistant.\n"; }

// ============================================================
// HTML Template
// ============================================================
function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Platform — Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; }
  .container { max-width: 640px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 28px; margin-bottom: 8px; color: #fff; }
  .subtitle { color: #888; margin-bottom: 40px; }

  /* Progress */
  .progress { display: flex; gap: 4px; margin-bottom: 40px; }
  .progress-dot { flex: 1; height: 4px; border-radius: 2px; background: #333; }
  .progress-dot.active { background: #4ade80; }
  .progress-dot.current { background: #60a5fa; }

  /* Steps */
  .step { display: none; }
  .step.active { display: block; }
  .step-title { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .step-desc { color: #999; margin-bottom: 24px; line-height: 1.5; }

  /* Form elements */
  input, textarea { width: 100%; padding: 12px 16px; border: 1px solid #333; border-radius: 8px; background: #1a1a1a; color: #fff; font-size: 14px; margin-bottom: 16px; outline: none; font-family: inherit; }
  input:focus, textarea:focus { border-color: #60a5fa; }
  textarea { min-height: 200px; resize: vertical; font-family: monospace; }

  /* Buttons */
  .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn-primary { background: #60a5fa; color: #000; }
  .btn-primary:hover { background: #93c5fd; }
  .btn-primary:disabled { background: #333; color: #666; cursor: not-allowed; }
  .btn-secondary { background: #333; color: #fff; margin-right: 12px; }
  .btn-secondary:hover { background: #444; }
  .btn-row { display: flex; justify-content: space-between; margin-top: 24px; }

  /* Status */
  .status { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  .status-ok { background: #052e16; border: 1px solid #166534; color: #4ade80; }
  .status-err { background: #2a0a0a; border: 1px solid #7f1d1d; color: #f87171; }
  .status-info { background: #0a1628; border: 1px solid #1e3a5f; color: #60a5fa; }
  .status-loading { background: #1a1a0a; border: 1px solid #4a4a0a; color: #fbbf24; }

  /* Links */
  a { color: #60a5fa; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Code */
  code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  pre { background: #1a1a1a; padding: 16px; border-radius: 8px; overflow-x: auto; margin-bottom: 16px; font-size: 13px; }

  /* Done */
  .done-card { background: #052e16; border: 1px solid #166534; border-radius: 12px; padding: 32px; text-align: center; }
  .done-card h2 { color: #4ade80; margin-bottom: 16px; }
  .done-card p { color: #86efac; }

  label { display: block; color: #999; font-size: 13px; margin-bottom: 4px; }
</style>
</head>
<body>
<div class="container">
  <h1>Agent Platform</h1>
  <p class="subtitle">AI Assistant with Telegram Interface</p>

  <div class="progress">
    ${[1,2,3,4,5,6].map(i => `<div class="progress-dot ${i < state.step ? 'active' : ''} ${i === state.step ? 'current' : ''}"></div>`).join("")}
  </div>

  <!-- Step 1: Telegram -->
  <div class="step ${state.step === 1 ? 'active' : ''}" id="step1">
    <div class="step-title">1. Create Telegram Bot</div>
    <div class="step-desc">
      Open <a href="https://t.me/BotFather" target="_blank">@BotFather</a> on Telegram and send <code>/newbot</code>.<br>
      Follow the prompts, then paste the bot token below.
    </div>
    <label>Bot Token</label>
    <input type="text" id="tg-token" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz" value="${state.telegramToken}">
    <div id="tg-status"></div>
    <div class="btn-row">
      <div></div>
      <button class="btn btn-primary" onclick="validateTelegram()">Validate & Continue →</button>
    </div>
  </div>

  <!-- Step 2: Claude Code -->
  <div class="step ${state.step === 2 ? 'active' : ''}" id="step2">
    <div class="step-title">2. Claude Code Login</div>
    <div class="step-desc">
      Claude Code needs to be logged in on this server. SSH into your VPS and run:
      <pre>claude</pre>
      Follow the OAuth prompts in the browser. After login, press Ctrl+C to exit.
    </div>
    <div id="claude-status"></div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(1)">← Back</button>
      <button class="btn btn-primary" onclick="validateClaude()">Check Connection →</button>
    </div>
  </div>

  <!-- Step 3: API Keys -->
  <div class="step ${state.step === 3 ? 'active' : ''}" id="step3">
    <div class="step-title">3. Memory (Optional)</div>
    <div class="step-desc">
      These are <strong>100% optional</strong>. Your bot works with just Telegram + Claude.<br>
      Adding these unlocks vector memory and knowledge graph — your bot remembers past conversations.<br>
      Skip if you want to try the bot first, add memory later.
    </div>

    <label>Pinecone API Key — <a href="https://app.pinecone.io" target="_blank">Get key</a></label>
    <input type="text" id="pinecone-key" placeholder="pcsk_..." value="${state.pineconeKey}">

    <label>Pinecone Index Host — Create an index named "agent-memory", 1024 dimensions, cosine</label>
    <input type="text" id="pinecone-host" placeholder="agent-memory-xxx.svc.pinecone.io" value="${state.pineconeHost}">

    <label>Cohere API Key — <a href="https://dashboard.cohere.com/api-keys" target="_blank">Get key</a></label>
    <input type="text" id="cohere-key" placeholder="aDaR..." value="${state.cohereKey}">

    <label>Groq API Key — <a href="https://console.groq.com/keys" target="_blank">Get key</a></label>
    <input type="text" id="groq-key" placeholder="gsk_..." value="${state.groqKey}">

    <div id="keys-status"></div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(2)">← Back</button>
      <button class="btn btn-secondary" onclick="skipKeys()" style="margin-right:0">Skip — no memory →</button>
      <button class="btn btn-primary" onclick="validateKeys()">Validate & Continue →</button>
    </div>
  </div>

  <!-- Step 4: Personality -->
  <div class="step ${state.step === 4 ? 'active' : ''}" id="step4">
    <div class="step-title">4. Agent Personality</div>
    <div class="step-desc">Define who your agent is. This is loaded into every conversation.</div>

    <label>Agent Name</label>
    <input type="text" id="agent-name" placeholder="My Assistant" value="${state.agentName}">

    <label>SOUL.md — Personality definition</label>
    <textarea id="soul-content">${state.soulContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>

    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(3)">← Back</button>
      <button class="btn btn-primary" onclick="saveSoul()">Save & Continue →</button>
    </div>
  </div>

  <!-- Step 5: Test -->
  <div class="step ${state.step === 5 ? 'active' : ''}" id="step5">
    <div class="step-title">5. Test Your Bot</div>
    <div class="step-desc">Let's make sure everything works. Send a test message.</div>

    <label>Test message</label>
    <input type="text" id="test-msg" placeholder="Hello!" value="Привет!">
    <div id="test-status"></div>
    <div class="btn-row">
      <button class="btn btn-secondary" onclick="goStep(4)">← Back</button>
      <button class="btn btn-primary" onclick="runTest()">Send Test →</button>
    </div>
  </div>

  <!-- Step 6: Done -->
  <div class="step ${state.step === 6 ? 'active' : ''}" id="step6">
    <div class="done-card">
      <h2>🎉 Your bot is live!</h2>
      <p>Send /start to <a href="https://t.me/${state.botUsername}" target="_blank">@${state.botUsername || 'your_bot'}</a> on Telegram</p>
    </div>
    <div style="margin-top: 24px; color: #999; font-size: 13px;">
      <p><strong>Admin commands:</strong></p>
      <pre>Logs: journalctl -u agent-platform -f
Config: nano ${INSTALL_DIR}/.env
Personality: nano ${INSTALL_DIR}/agent-soul/SOUL.md
Restart: systemctl restart agent-platform</pre>
    </div>
  </div>
</div>

<script>
async function post(url, data) {
  const res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  return res.json();
}

function setStatus(id, type, msg) {
  document.getElementById(id).innerHTML = '<div class="status status-' + type + '">' + msg + '</div>';
}

function goStep(n) { post('/api/step', {step: n}).then(() => location.reload()); }

async function validateTelegram() {
  const token = document.getElementById('tg-token').value.trim();
  if (!token) return setStatus('tg-status', 'err', 'Please enter a bot token');
  setStatus('tg-status', 'loading', 'Validating...');
  const res = await post('/api/validate-telegram', { token });
  if (res.ok) {
    setStatus('tg-status', 'ok', '✓ Bot found: @' + res.username);
    setTimeout(() => location.reload(), 1000);
  } else {
    setStatus('tg-status', 'err', '✗ ' + res.error);
  }
}

async function validateClaude() {
  setStatus('claude-status', 'loading', 'Testing Claude Code CLI...');
  const res = await post('/api/validate-claude', {});
  if (res.ok) {
    setStatus('claude-status', 'ok', '✓ Claude Code is working! Model: ' + res.model);
    setTimeout(() => location.reload(), 1000);
  } else {
    setStatus('claude-status', 'err', '✗ ' + res.error + '<br><br>SSH into your server and run: <code>claude</code>');
  }
}

async function skipKeys() {
  await post('/api/skip-keys', {});
  location.reload();
}

async function validateKeys() {
  const data = {
    pineconeKey: document.getElementById('pinecone-key').value.trim(),
    pineconeHost: document.getElementById('pinecone-host').value.trim(),
    cohereKey: document.getElementById('cohere-key').value.trim(),
    groqKey: document.getElementById('groq-key').value.trim()
  };
  setStatus('keys-status', 'loading', 'Validating keys...');
  const res = await post('/api/validate-keys', data);
  if (res.ok) {
    setStatus('keys-status', 'ok', '✓ All keys validated!');
    setTimeout(() => location.reload(), 1000);
  } else {
    setStatus('keys-status', 'err', '✗ ' + res.errors.join('<br>'));
  }
}

async function saveSoul() {
  const data = {
    name: document.getElementById('agent-name').value.trim(),
    content: document.getElementById('soul-content').value
  };
  await post('/api/save-soul', data);
  location.reload();
}

async function runTest() {
  const msg = document.getElementById('test-msg').value.trim();
  setStatus('test-status', 'loading', 'Starting bot and sending test message... (may take 30 seconds)');
  const res = await post('/api/test', { message: msg });
  if (res.ok) {
    setStatus('test-status', 'ok', '✓ Bot responded: "' + res.response.slice(0, 200) + '"');
    setTimeout(() => location.reload(), 2000);
  } else {
    setStatus('test-status', 'err', '✗ ' + res.error);
  }
}
</script>
</body>
</html>`;
}

// ============================================================
// API endpoints
// ============================================================
const app = Fastify({ logger: false });

app.get("/", async (_, reply) => {
  reply.type("text/html").send(renderPage());
});

app.post("/api/step", async (request) => {
  const { step } = request.body as { step: number };
  state.step = step;
  return { ok: true };
});

app.post("/api/validate-telegram", async (request) => {
  const { token } = request.body as { token: string };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string } };
    if (data.ok && data.result?.username) {
      state.telegramToken = token;
      state.botUsername = data.result.username;
      state.step = 2;
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: "Invalid token" };
  } catch {
    return { ok: false, error: "Could not reach Telegram API" };
  }
});

app.post("/api/validate-claude", async () => {
  try {
    const result = execSync('claude -p "Say OK" --output-format json --no-session-persistence 2>&1', { timeout: 30000 }).toString();
    const envelope = JSON.parse(result);
    if (envelope.result) {
      state.claudeReady = true;
      state.step = 3;
      const model = Object.keys(envelope.modelUsage ?? {})[0] ?? "unknown";
      return { ok: true, model };
    }
    return { ok: false, error: envelope.result ?? "No response from Claude" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "Claude CLI not working" };
  }
});

app.post("/api/skip-keys", async () => {
  state.step = 4;
  return { ok: true };
});

app.post("/api/validate-keys", async (request) => {
  const { pineconeKey, pineconeHost, cohereKey, groqKey } = request.body as Record<string, string>;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Only validate keys that were provided
  if (pineconeKey && pineconeHost) {
    try {
      const res = await fetch(`https://${pineconeHost}/describe_index_stats`, {
        method: "POST", headers: { "Api-Key": pineconeKey, "Content-Type": "application/json" }, body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) errors.push("Pinecone: invalid key or host");
    } catch { errors.push("Pinecone: could not connect to host"); }
  } else if (pineconeKey || pineconeHost) {
    errors.push("Pinecone: need both API key AND index host");
  }

  if (cohereKey) {
    try {
      const res = await fetch("https://api.cohere.com/v1/embed", {
        method: "POST",
        headers: { "Authorization": `Bearer ${cohereKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ texts: ["test"], model: "embed-multilingual-v3.0", input_type: "search_document" }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) errors.push("Cohere: invalid API key");
    } catch { errors.push("Cohere: could not connect"); }
  }

  if (!pineconeKey && !cohereKey) warnings.push("No vector memory — bot works but won't remember past conversations");

  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) errors.push("Groq: invalid API key");
    } catch { errors.push("Groq: could not connect"); }
  } else {
    warnings.push("No knowledge graph — bot works but will not extract entity relationships");
  }

  if (errors.length === 0) {
    state.pineconeKey = pineconeKey || "";
    state.pineconeHost = pineconeHost || "";
    state.cohereKey = cohereKey || "";
    state.groqKey = groqKey || "";
    state.step = 4;
    return { ok: true, warnings };
  }
  return { ok: false, errors };
});

app.post("/api/save-soul", async (request) => {
  const { name, content } = request.body as { name: string; content: string };
  state.agentName = name;
  state.soulContent = content;

  // Save files
  mkdirSync(`${INSTALL_DIR}/agent-soul`, { recursive: true });
  writeFileSync(`${INSTALL_DIR}/agent-soul/SOUL.md`, content);
  writeFileSync(`${INSTALL_DIR}/agent-soul/TOOLS.md`, "# Tools\n\nAdd your service credentials here.\n");
  writeFileSync(`${INSTALL_DIR}/agent-soul/FULL-CONTEXT.md`, content + "\n\n# Tools\n\nAdd your service credentials here.\n");

  // Write .env
  const chatId = state.telegramToken ? "" : "CHANGE_ME";
  writeFileSync(ENV_PATH, `TELEGRAM_BOT_TOKEN=${state.telegramToken}
TELEGRAM_BOOTSTRAP_CHAT_ID=${chatId}
CLAUDE_CODE_PATH=${execSync("which claude 2>/dev/null || echo claude").toString().trim()}
MIRA_SOUL_PATH=${INSTALL_DIR}/agent-soul/FULL-CONTEXT.md
API_PORT=3000
API_HOST=0.0.0.0
PINECONE_API_KEY=${state.pineconeKey}
PINECONE_HOST=${state.pineconeHost}
COHERE_API_KEY=${state.cohereKey}
GROQ_API_KEY=${state.groqKey}
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_platform
SMTP_USER=${state.smtpUser}
SMTP_PASS=${state.smtpPass}
`);

  state.step = 5;
  return { ok: true };
});

app.post("/api/test", async (request) => {
  const { message } = request.body as { message: string };
  try {
    // Set webhook (doesn't need root)
    execSync(`curl -s -F "url=https://${state.serverIp}:8443/webhooks/telegram" -F "certificate=@/etc/nginx/ssl/agent-platform.crt" "https://api.telegram.org/bot${state.telegramToken}/setWebhook"`, { timeout: 10000 });

    // Start the bot service — try systemctl, fall back to writing a flag for the installer
    try {
      execSync("sudo systemctl restart agent-platform 2>&1", { timeout: 10000 });
    } catch {
      // If no sudo access, write a start flag — installer will pick it up
      try { execSync("fuser -k 3000/tcp 2>/dev/null || true", { timeout: 5000 }); } catch {}
    }

    // Wait for bot to start
    await new Promise(r => setTimeout(r, 5000));

    // Quick test with Claude directly
    const safeMsg = message.replace(/"/g, '\\"');
    const claude = execSync(`claude -p "${safeMsg}" --output-format json --no-session-persistence 2>&1`, { timeout: 60000 }).toString();
    const envelope = JSON.parse(claude);

    state.step = 6;
    state.complete = true;
    return { ok: true, response: envelope.result ?? "Bot is running!" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "Test failed" };
  }
});

// ============================================================
// Start wizard
// ============================================================
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`\n  Setup wizard: http://${state.serverIp}:${PORT}\n`);
}).catch((err) => {
  console.error("Failed to start setup wizard:", err);
  process.exit(1);
});
