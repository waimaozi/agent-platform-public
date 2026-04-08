# Agent Platform — AI Assistant with Telegram Interface

A lightweight AI agent that connects to Telegram, filters noise cheaply, and uses Claude Code CLI for real work.

## Architecture

```
Telegram message
    │
    ├── Regex: banter/junk? → auto-reply ($0)
    ├── Regex: command? → handle directly ($0)
    │
    └── Real question → spawn claude -p "question"
                         --dangerously-skip-permissions
                         --system-prompt-file SOUL.md
                         → parse response
                         → send to Telegram
```

## Why this works

- **60% of messages are banter** — handled by regex for free
- **No growing context** — each call is cold-start with a system prompt
- **Claude Code CLI is the agent runtime** — file access, bash, git, web search built-in
- **200 lines of code** — not 14,000

## Economics

| Message type | Cost (API) | Cost (subscription) |
|---|---|---|
| Banter/commands | $0.00 | $0.00 |
| Simple question | $0.04-0.08 | $0.00 |
| Complex task (multi-tool) | $0.15-0.50 | $0.00 |

On Claude Max subscription ($100/mo): unlimited usage within rate limits.

## Setup

1. Create a Telegram bot via @BotFather
2. Install Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
3. Login: `claude` (follow OAuth prompts)
4. Copy `.env.example` to `.env` and fill in your values
5. Customize `docs/examples/SOUL.md` with your agent's personality
6. Set Telegram webhook:
   ```bash
   # Generate self-signed cert
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -keyout ssl.key -out ssl.crt -subj '/CN=YOUR_IP'
   
   # Set webhook
   curl -F "url=https://YOUR_IP:8443/webhooks/telegram" \
        -F "certificate=@ssl.crt" \
        https://api.telegram.org/botYOUR_TOKEN/setWebhook
   ```
7. Run: `npx tsx simple-bot.ts`

## Commands

- `/start` — welcome message
- `/help` — command list
- `/pin <fact>` — remember a fact
- `/cost` — pricing info

## Customization

- **SOUL.md** — agent personality, loaded via `--system-prompt-file`
- **TOOLS.md** — service credentials, loaded into agent context
- **Regex patterns** — edit GREETING_RE, BANTER_RE, JUNK_RE in simple-bot.ts
- **Timeout** — CLAUDE_TIMEOUT in simple-bot.ts (default 10 min)

## Can I use a different LLM?

The architecture is LLM-agnostic. Replace the `callClaude()` function with any CLI/API:
- OpenAI: `openai api chat.completions.create ...`
- Codex: `codex exec ...`  
- Local: `ollama run ...`
- LangChain/LangGraph: wrap in a Python script called via spawn

## V1 (full pipeline)

The `v1-full-pipeline` git tag contains the full version with:
- Scoped memory (6 layers), frontdesk classifier, context bundle builder
- Supervisor → Researcher → Coder → Verifier pipeline
- Approval flow, cost tracking, secrets service
- 55+ tests, 14k lines

We simplified to v2 (this version) because 20% of the code delivered 80% of the value.

## License

MIT
