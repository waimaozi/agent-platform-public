#!/bin/bash
set -a
source /home/user/agent-platform/.env
set +a
export PATH=/home/user/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
cd /home/user/agent-platform
exec /home/user/agent-platform/node_modules/.bin/tsx apps/worker/src/main.ts
