# Agent Platform — Installation & Management Guide

This file tells you how to install, configure, and manage this project.

## Fresh Install

When asked to install this project on a server:

1. Install system deps:
```bash
apt-get update && apt-get install -y docker.io docker-compose nginx pandoc
```

2. Clone to /opt/agent-platform (if not already there):
```bash
git clone https://github.com/waimaozi/agent-platform-public.git /opt/agent-platform
cd /opt/agent-platform
pnpm install
```

3. Start Postgres + Redis:
```bash
docker-compose up -d
```

4. Generate SSL cert and configure nginx:
```bash
SERVER_IP=$(curl -s ifconfig.me)
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/agent-platform.key \
  -out /etc/nginx/ssl/agent-platform.crt \
  -subj "/CN=${SERVER_IP}"
```
Write nginx config to /etc/nginx/sites-enabled/agent-platform:
- Listen on 8443 SSL
- Proxy to 127.0.0.1:3000
- Set proxy_read_timeout to 600s

Reload nginx.

5. Create .env from .env.example. Ask the user for:
   - TELEGRAM_BOT_TOKEN (required — get from @BotFather)
   - Optionally: PINECONE_API_KEY, PINECONE_HOST, COHERE_API_KEY, GROQ_API_KEY

6. Create agent-soul/SOUL.md — ask the user what personality they want, or use docs/examples/SOUL.md

7. Create agent-soul/TOOLS.md — add any service credentials the user provides

8. Merge: cat agent-soul/SOUL.md agent-soul/TOOLS.md > agent-soul/FULL-CONTEXT.md

9. Create systemd service:
```bash
cat > /etc/systemd/system/agent-platform.service << EOF
[Unit]
Description=Agent Platform Bot
After=network.target docker.service
[Service]
Type=simple
WorkingDirectory=/opt/agent-platform
ExecStart=/bin/bash -c 'set -a; source /opt/agent-platform/.env; set +a; exec npx tsx simple-bot.ts'
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable agent-platform
systemctl start agent-platform
```

10. Set Telegram webhook:
```bash
curl -F "url=https://${SERVER_IP}:8443/webhooks/telegram" \
     -F "certificate=@/etc/nginx/ssl/agent-platform.crt" \
     "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook"
```

11. Verify: curl https://${SERVER_IP}:8443/health

## Architecture

- simple-bot.ts — the entire bot (~300 lines)
- Regex frontdesk filters banter/junk for $0
- Real questions → Claude Code CLI (you) via spawn
- Three memory layers: Postgres full-text (always), Pinecone vector (optional), knowledge graph (optional)
- Features auto-detected from .env vars

## Common Tasks

- Restart: `systemctl restart agent-platform`
- Logs: `journalctl -u agent-platform -f`
- Edit personality: edit agent-soul/SOUL.md, then rebuild FULL-CONTEXT.md
- Edit config: edit .env, then restart
- Update: `cd /opt/agent-platform && git pull && pnpm install && systemctl restart agent-platform`

## File Structure

```
simple-bot.ts          — main bot
agent-soul/SOUL.md     — personality
agent-soul/TOOLS.md    — service credentials
agent-soul/FULL-CONTEXT.md — merged (auto-generated)
.env                   — configuration
docker-compose.yml     — Postgres + Redis
```

## Resilience — How the Bot Handles Failures

The bot has built-in self-healing:

- **Concurrency limit:** max 2 Claude processes at once, rest queued with position feedback
- **Heartbeat:** user gets "still working..." every 2 min so they know bot is alive
- **Stale task reaper:** kills stuck processes past 30 min timeout + notifies user
- **Per-chat dedup:** follow-up messages batched while a task is running
- **Message splitting:** responses over 4096 chars split at newline boundaries
- **Markdown fallback:** tries Markdown first, retries plain text if Telegram rejects

### SOUL.md Resilience Rules (add these to any agent personality)

Every SOUL.md should include rules for handling external API failures:

- Set 60s timeout on any external API call (curl --max-time 60)
- Max 2 retries on a failing service, then report and move on
- Never silently loop — tell the user what failed and suggest trying later
- A fast honest answer is better than a long empty wait

Without these rules, the agent may spend its entire 30-min timeout retrying a dead API.
