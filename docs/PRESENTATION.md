# Agent Platform
### AI Assistant with Telegram Interface

---

## What is it?

A Telegram bot backed by Claude Code CLI that acts as a personal AI agent — reads files, runs commands, calls APIs, and answers questions.

**The key insight:** 60% of messages in any conversation are noise (greetings, thanks, emoji). We filter those for $0 and only wake the expensive AI for real work.

---

## Architecture

```
User sends message to Telegram bot
         │
         ├── "Привет!" → Regex: banter → instant reply ($0)
         ├── "👍"       → Regex: junk   → ignore ($0)
         ├── "/help"    → Command       → handle directly ($0)
         │
         └── Real question/task
              → spawn claude -p "question"
              → Claude thinks, reads files, calls APIs
              → Response sent back to Telegram
```

**One spawn call. No framework. No queue. No pipeline.**

---

## Why not LangChain/LangGraph?

| | LangChain/LangGraph | Agent Platform |
|---|---|---|
| **Lines of code** | 5,000+ | 200 |
| **Dependencies** | 50+ packages | 3 (fastify, zod, claude-cli) |
| **Tool use** | Manual tool definitions | Built into Claude Code CLI |
| **File access** | Custom implementation | `--add-dir` flag |
| **Bash/git/curl** | Custom tools | Built-in |
| **Setup time** | Hours | 10 minutes |

Claude Code CLI IS the agent runtime. We just point it at Telegram.

---

## Economics

### Cost per interaction

| Type | What happens | API cost | Subscription cost |
|---|---|---|---|
| Banter (60%) | Regex filter | $0.00 | $0.00 |
| Commands (10%) | Direct handler | $0.00 | $0.00 |
| Simple Q (20%) | 1 Claude call | $0.04-0.08 | $0.00 |
| Complex task (10%) | Multi-tool call | $0.15-0.50 | $0.00 |

### Monthly comparison

| Approach | Cost/month |
|---|---|
| Direct LLM chat (every msg → Opus) | ~$720 |
| Agent Platform on API | ~$80 |
| Agent Platform on subscription | $100 flat (Claude Max) |
| **Savings** | **88%** |

---

## What makes it different

### 1. No growing context
Each call starts fresh. No O(n²) cost explosion.
System prompt (personality) loaded from file, not from chat history.

### 2. Cheap-first routing
Regex handles 60% of traffic. Free.
Only real questions reach the expensive model.

### 3. Full autonomy
`--dangerously-skip-permissions` gives the agent:
- File read/write anywhere
- Bash commands
- Network requests (curl, fetch)
- Git operations

### 4. Personality via file
`SOUL.md` defines who the agent is. Change the file, change the personality.

### 5. Memory between messages
`[ЗАПОМНИТЬ]: fact` tag in responses → saved to log file → loaded on next call.
Simple, no vector DB needed.

---

## Setup (10 minutes)

```bash
# 1. Create Telegram bot
# → Talk to @BotFather, get token

# 2. Install Claude Code
npm install -g @anthropic-ai/claude-code
claude  # login

# 3. Clone and configure
git clone https://github.com/waimaozi/agent-platform-public
cd agent-platform-public
cp .env.example .env
# Edit .env: add bot token, paths

# 4. Customize personality
cp docs/examples/SOUL.md my-soul.md
# Edit: define who your agent is

# 5. Set webhook (self-signed cert)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ssl.key -out ssl.crt -subj '/CN=YOUR_IP'
curl -F "url=https://YOUR_IP:8443/webhooks/telegram" \
     -F "certificate=@ssl.crt" \
     https://api.telegram.org/botYOUR_TOKEN/setWebhook

# 6. Run
npx tsx simple-bot.ts
```

---

## What's inside

```
simple-bot.ts          ← The entire bot (200 lines)
docs/examples/
  SOUL.md              ← Agent personality template
  TOOLS.md             ← Service credentials template
.env.example           ← Configuration
docker-compose.yml     ← Postgres + Redis (optional)
```

### Also included (v1 reference):
```
packages/              ← Full pipeline architecture
  contracts/           ← Zod schemas
  frontdesk/           ← Nano model classifier
  supervisor-runtime/  ← Claude CLI wrapper
  memory-fabric/       ← Scoped memory (6 layers)
  bundle-builder/      ← Context assembly
  secrets-service/     ← Encrypted credential storage
tests/                 ← 55+ tests
```

---

## Scaling to SaaS

| Users | API cost/mo | Subscription cost/mo | Revenue at $49/user | Profit |
|---|---|---|---|---|
| 1 | $80 | $100 | $49 | -$131 |
| 7 | $560 | $100 | $343 | +$243 |
| 20 | $1,600 | $200* | $980 | +$780 |
| 50 | $4,000 | $300* | $2,450 | +$2,150 |

*May need multiple subscriptions at scale

**Break-even on subscription: 3 users**

---

## Customization points

| What | How |
|---|---|
| Personality | Edit SOUL.md |
| Service access | Edit TOOLS.md |
| Banter patterns | Edit regex in simple-bot.ts |
| Timeout | CLAUDE_TIMEOUT constant |
| Commands | Add to handleCommand() |
| LLM provider | Replace callClaude() function |
| Memory | Modify appendMemory()/getRecentMemory() |

---

## Roadmap (from v1)

Already built in v1 (tagged `v1-full-pipeline`), ready to re-add:

- [ ] Scoped memory (6 layers with TTL)
- [ ] Nano frontdesk (free LLM classifier via OpenRouter)
- [ ] Approval flow for dangerous operations
- [ ] Cost tracking per task
- [ ] Voice message transcription
- [ ] Email sending (SMTP)
- [ ] N8N workflow integration
- [ ] Project tracker with deadlines
- [ ] Self-healing error reports
- [ ] Proactive check-in cron

---

## Summary

**200 lines of TypeScript** that give you a personal AI agent in Telegram.

- Filters noise for free
- Uses Claude Code CLI as the brain
- Full file/bash/network autonomy
- Personality from a file
- 88% cheaper than naive LLM chat

**GitHub:** github.com/waimaozi/agent-platform-public

---

*Built in 2 days with Claude Code + OpenAI Codex as coding agents.*
