#!/bin/bash
set -a
source /home/openclaw/agent-platform/.env
set +a
export PATH=/home/openclaw/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
cd /home/openclaw/agent-platform
exec /home/openclaw/agent-platform/node_modules/.bin/tsx apps/worker/src/main.ts
