#!/bin/bash
set -a
source /home/openclaw/agent-platform/.env
set +a
export PATH=/home/openclaw/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
cd /home/openclaw/agent-platform

# Wait for connectivity
for i in 1 2 3; do
  curl -s https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe > /dev/null 2>&1 && break
  sleep 2
done

exec /home/openclaw/agent-platform/node_modules/.bin/tsx simple-bot.ts
