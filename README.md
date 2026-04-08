# Agent Platform — AI Assistant with Telegram Interface

A lightweight AI agent that connects to Telegram, filters noise cheaply, and uses Claude Code CLI for real work. With vector memory and knowledge graph for persistent context.

## Architecture

```
User sends message to Telegram bot
         │
         ├── "Привет!" → Regex: banter → instant reply ($0)
         ├── "👍"       → Regex: junk   → ignore ($0)
         ├── "/help"    → Command       → handle directly ($0)
         │
         └── Real question/task
              │
              ├── Embed (Cohere) → store in Pinecone     ~$0.0001
              ├── Extract triples (Groq) → Postgres       free
              │
              ├── Vector search → similar past context
              ├── Graph query → connected entities (2-hop)
              │
              └── spawn claude -p "question + context"
                   → Claude thinks, reads files, calls APIs
                   → Response sent back to Telegram
```

## Three Memory Layers

### 1. System Prompt (SOUL.md + TOOLS.md)
Loaded on every call. Defines personality and available tools.

### 2. Vector Memory (Pinecone + Cohere)
Every message is embedded and stored. On each question, the 5 most similar past interactions are retrieved and injected as context.
- **Finds:** things semantically similar to the current question
- **Cost:** ~$0.0001 per embed (Cohere), Pinecone free tier

### 3. Knowledge Graph (Postgres + Groq)
Every message is processed by a cheap model (Llama 3.1 8B via Groq) that extracts entity-relationship triples: (subject, predicate, object). Stored in Postgres. On each question, a 2-hop graph traversal finds connected entities.
- **Finds:** things connected but not necessarily similar
- **Cost:** free (Groq free tier)
- **Example:** "ByPlan" → uses → "ArchiCAD" → expert → "Наталья" — connections vector search would miss

## Economics

| Message type | Vector | Graph | Claude | Total |
|---|---|---|---|---|
| Banter | — | — | — | $0.00 |
| Simple question | $0.0001 | free | $0.04 | $0.04 |
| Complex task | $0.0001 | free | $0.15-0.50 | $0.15-0.50 |
| Question with memory context | $0.0001 | free | $0.04 | $0.04 |

With memory: same question that cost $0.30 (Claude exploring files) costs $0.04 the second time (answer from memory).

## Features

- **Regex frontdesk** — 60% of messages handled for $0
- **Vector memory** — semantic search across all past interactions
- **Knowledge graph** — entity relationships via triple extraction
- **File handling** — upload DOCX/PDF/images, auto-converts to text via pandoc
- **Forum/topic support** — works in Telegram supergroups with topics
- **Email sending** — direct SMTP via /email command
- **Typing indicator** — "typing..." while Claude thinks
- **Message splitting** — auto-splits long responses for Telegram's 4096 char limit
- **Session log** — last 20 events as linear memory
- **Pinned facts** — /pin to remember specific facts
- **10 min timeout** — handles complex multi-tool tasks
- **50 tool turns** — Claude can read files, curl APIs, run bash in one call

## Setup

```bash
# 1. Create Telegram bot via @BotFather, get token
# 2. Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude  # login with OAuth

# 3. Clone and configure
git clone https://github.com/waimaozi/agent-platform-public
cd agent-platform-public
cp .env.example .env
# Edit .env with your keys

# 4. Install dependencies
pnpm install

# 5. Start Postgres (for knowledge graph)
docker-compose up -d

# 6. Create a Pinecone index
# Go to pinecone.io, create "agent-memory" index, 1024 dimensions, cosine

# 7. Customize personality
cp docs/examples/SOUL.md my-soul.md
# Edit with your agent's personality

# 8. Set Telegram webhook
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ssl.key -out ssl.crt -subj '/CN=YOUR_IP'
curl -F "url=https://YOUR_IP:8443/webhooks/telegram" \
     -F "certificate=@ssl.crt" \
     https://api.telegram.org/botYOUR_TOKEN/setWebhook

# 9. Run
npx tsx simple-bot.ts
```

## Commands

| Command | Description |
|---|---|
| /start | Welcome message |
| /help | Command list |
| /pin \<fact\> | Remember a fact |
| /email to Subject \| Body | Send email via SMTP |
| /cost | Pricing info |

## Customization

| What | How |
|---|---|
| Personality | Edit SOUL.md |
| Service access | Edit TOOLS.md |
| Banter patterns | Edit GREETING_RE, BANTER_RE, JUNK_RE |
| Timeout | CLAUDE_TIMEOUT constant |
| Vector search results | topK parameter in searchMemory() |
| Graph traversal depth | hops parameter in queryGraph() |
| LLM provider | Replace callClaude() function |
| Triple extraction model | Change model in extractAndStoreTriples() |

## Can I use a different LLM?

Yes. Replace `callClaude()` with any CLI or API call. The memory layers (vector + graph) are LLM-agnostic.

## License

MIT
