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

## Install (copy-paste on a fresh VPS)

Before you start: create a Telegram bot via @BotFather and save the token.

**One command:**
```bash
curl -fsSL https://raw.githubusercontent.com/waimaozi/agent-platform-public/main/install.sh | bash
```

This installs everything (Node, Docker, nginx, SSL, Postgres) and opens a setup wizard at `http://YOUR_IP:8888`. Follow the steps, paste your Telegram token, choose a personality — done.

**What you need:**
- A VPS (Ubuntu 22+, 2GB+ RAM)
- A Telegram bot token (free, from @BotFather)
- Claude Code account on the VPS (`claude` CLI logged in as the `agent` user)

**Optional (for memory features):**
- Pinecone API key + index (1024 dims, cosine) + Cohere API key → vector memory
- Groq API key → knowledge graph extraction

**After install:**
```bash
journalctl -u agent-platform -f    # logs
systemctl restart agent-platform    # restart
curl -k https://YOUR_IP:8443/health # health check
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
