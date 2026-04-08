#!/bin/bash
set -e

# ============================================================
# Agent Platform — One-Click Installer
# ============================================================
echo "╔══════════════════════════════════════════╗"
echo "║    Agent Platform — Installer v2         ║"
echo "║    AI Assistant with Telegram Interface  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
ask() { read -p "$(echo -e "${YELLOW}[?]${NC} $1: ")" "$2"; }

# ============================================================
# Step 1: System dependencies
# ============================================================
echo ""
echo "━━━ Step 1/9: System dependencies ━━━"

if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  log "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  log "Node.js $(node -v) found"
fi

if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm..."
  npm install -g pnpm
else
  log "pnpm found"
fi

if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
else
  log "Docker found"
fi

if ! command -v docker-compose &>/dev/null; then
  log "Installing docker-compose..."
  apt-get install -y docker-compose
else
  log "docker-compose found"
fi

if ! command -v nginx &>/dev/null; then
  log "Installing nginx..."
  apt-get install -y nginx
else
  log "nginx found"
fi

if ! command -v pandoc &>/dev/null; then
  log "Installing pandoc..."
  apt-get install -y pandoc
else
  log "pandoc found"
fi

# ============================================================
# Step 2: Clone and install
# ============================================================
echo ""
echo "━━━ Step 2/9: Clone repository ━━━"

INSTALL_DIR="/opt/agent-platform"
if [ -d "$INSTALL_DIR" ]; then
  warn "$INSTALL_DIR already exists. Updating..."
  cd "$INSTALL_DIR" && git pull 2>/dev/null || true
else
  git clone https://github.com/waimaozi/agent-platform-public.git "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
log "Installing dependencies..."
pnpm install --prod 2>/dev/null || pnpm install
log "Dependencies installed"

# ============================================================
# Step 3: Configuration
# ============================================================
echo ""
echo "━━━ Step 3/9: Configuration ━━━"
echo "You'll need these API keys. Get them from:"
echo "  • Telegram bot token: @BotFather on Telegram"
echo "  • Pinecone: https://pinecone.io (free tier)"
echo "  • Cohere: https://cohere.com (free tier)"
echo "  • Groq: https://groq.com (free tier)"
echo ""

if [ -f .env ]; then
  warn ".env already exists. Skipping configuration."
  warn "Edit manually: nano $INSTALL_DIR/.env"
else
  ask "Telegram bot token" BOT_TOKEN
  ask "Your Telegram chat ID (for admin messages)" CHAT_ID
  ask "Pinecone API key" PINE_KEY
  ask "Pinecone index host (e.g. my-index-xxx.svc.pinecone.io)" PINE_HOST
  ask "Cohere API key" COHERE_KEY
  ask "Groq API key" GROQ_KEY
  ask "SMTP email (Gmail with app password, or leave empty)" SMTP_USER
  ask "SMTP app password (or leave empty)" SMTP_PASS

  cat > .env << ENVEOF
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_BOOTSTRAP_CHAT_ID=${CHAT_ID}
CLAUDE_CODE_PATH=$(which claude 2>/dev/null || echo "claude")
MIRA_SOUL_PATH=${INSTALL_DIR}/agent-soul/FULL-CONTEXT.md
API_PORT=3000
API_HOST=0.0.0.0
PINECONE_API_KEY=${PINE_KEY}
PINECONE_HOST=${PINE_HOST}
COHERE_API_KEY=${COHERE_KEY}
GROQ_API_KEY=${GROQ_KEY}
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agent_platform
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
ENVEOF
  log ".env created"
fi

# ============================================================
# Step 4: Agent personality
# ============================================================
echo ""
echo "━━━ Step 4/9: Agent personality ━━━"

mkdir -p agent-soul
if [ ! -f agent-soul/SOUL.md ]; then
  cp docs/examples/SOUL.md agent-soul/SOUL.md
  log "Default SOUL.md created. Customize: nano $INSTALL_DIR/agent-soul/SOUL.md"
else
  log "SOUL.md already exists"
fi

if [ ! -f agent-soul/TOOLS.md ]; then
  cp docs/examples/TOOLS.md agent-soul/TOOLS.md
  log "Default TOOLS.md created. Customize: nano $INSTALL_DIR/agent-soul/TOOLS.md"
else
  log "TOOLS.md already exists"
fi

# Merge into FULL-CONTEXT.md
cat agent-soul/SOUL.md agent-soul/TOOLS.md > agent-soul/FULL-CONTEXT.md
log "FULL-CONTEXT.md assembled"

# ============================================================
# Step 5: Database
# ============================================================
echo ""
echo "━━━ Step 5/9: Database (Postgres) ━━━"

docker-compose up -d 2>/dev/null || docker compose up -d
sleep 5

# Wait for Postgres to be ready
for i in 1 2 3 4 5; do
  if docker exec $(docker ps -qf "ancestor=postgres:16-alpine" | head -1) pg_isready -U postgres 2>/dev/null; then
    break
  fi
  echo "  Waiting for Postgres... ($i)"
  sleep 3
done

log "Postgres running"

# ============================================================
# Step 6: SSL Certificate + nginx
# ============================================================
echo ""
echo "━━━ Step 6/9: SSL + nginx ━━━"

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
log "Server IP: $SERVER_IP"

mkdir -p /etc/nginx/ssl
if [ ! -f /etc/nginx/ssl/agent-platform.crt ]; then
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/agent-platform.key \
    -out /etc/nginx/ssl/agent-platform.crt \
    -subj "/CN=${SERVER_IP}" 2>/dev/null
  log "SSL certificate generated"
else
  log "SSL certificate exists"
fi

cat > /etc/nginx/sites-enabled/agent-platform << NGINXEOF
server {
    listen 8443 ssl;
    server_name ${SERVER_IP};
    ssl_certificate /etc/nginx/ssl/agent-platform.crt;
    ssl_certificate_key /etc/nginx/ssl/agent-platform.key;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 600s;
    }
}
NGINXEOF

nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || nginx
log "nginx configured on port 8443"

# ============================================================
# Step 7: Systemd service
# ============================================================
echo ""
echo "━━━ Step 7/9: Systemd service ━━━"

cat > /etc/systemd/system/agent-platform.service << SVCEOF
[Unit]
Description=Agent Platform Bot
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/bin/bash -c 'set -a; source ${INSTALL_DIR}/.env; set +a; exec $(which npx) tsx simple-bot.ts'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable agent-platform
log "Systemd service created"

# ============================================================
# Step 8: Claude Code login
# ============================================================
echo ""
echo "━━━ Step 8/9: Claude Code login ━━━"

if ! command -v claude &>/dev/null; then
  log "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
fi

echo ""
warn "You need to login to Claude Code interactively."
warn "Run this command and follow the prompts:"
echo ""
echo "    claude"
echo ""
warn "After login, press Ctrl+C to exit, then continue this script."
ask "Press Enter when Claude Code login is complete" _DUMMY

# ============================================================
# Step 9: Start and set webhook
# ============================================================
echo ""
echo "━━━ Step 9/9: Launch! ━━━"

systemctl start agent-platform
sleep 5

# Check if running
if systemctl is-active --quiet agent-platform; then
  log "Bot is running!"
else
  err "Bot failed to start. Check: journalctl -u agent-platform -n 20"
fi

# Set Telegram webhook
if [ -n "$BOT_TOKEN" ]; then
  RESULT=$(curl -s -F "url=https://${SERVER_IP}:8443/webhooks/telegram" \
    -F "certificate=@/etc/nginx/ssl/agent-platform.crt" \
    "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook")
  echo "$RESULT" | grep -q '"ok":true' && log "Telegram webhook set!" || warn "Webhook setup failed: $RESULT"
else
  source .env
  RESULT=$(curl -s -F "url=https://${SERVER_IP}:8443/webhooks/telegram" \
    -F "certificate=@/etc/nginx/ssl/agent-platform.crt" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook")
  echo "$RESULT" | grep -q '"ok":true' && log "Telegram webhook set!" || warn "Webhook setup failed: $RESULT"
fi

# ============================================================
# Done!
# ============================================================
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          Installation complete!          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Bot is running at: https://${SERVER_IP}:8443"
echo "  Logs: journalctl -u agent-platform -f"
echo "  Config: nano ${INSTALL_DIR}/.env"
echo "  Personality: nano ${INSTALL_DIR}/agent-soul/SOUL.md"
echo "  Restart: systemctl restart agent-platform"
echo ""
echo "  Send /start to your bot on Telegram to begin!"
echo ""
