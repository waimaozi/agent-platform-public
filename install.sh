#!/bin/bash
set -e

# Keep SSH alive during install
(while true; do echo -n "."; sleep 30; done) &
KEEPALIVE_PID=$!
trap "kill $KEEPALIVE_PID 2>/dev/null" EXIT

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    Agent Platform — One-Click Installer  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

INSTALL_DIR=/opt/agent-platform
BOT_USER=agent

# ── Must run as root ──
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash install.sh"
  exit 1
fi

# ── 1. Dependencies ──
echo "[1/7] Installing dependencies..."
apt-get update -qq
command -v node &>/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; }
command -v pnpm &>/dev/null || npm install -g pnpm
command -v docker &>/dev/null || apt-get install -y docker.io docker-compose
command -v nginx &>/dev/null || apt-get install -y nginx
command -v pandoc &>/dev/null || apt-get install -y pandoc
npm install -g @anthropic-ai/claude-code 2>/dev/null || true
echo "[1/7] Done"

# ── 2. Create non-root user + authenticate Claude Code ──
echo "[2/7] Setting up bot user..."
if ! id "$BOT_USER" &>/dev/null; then
  adduser --disabled-password --gecos "Agent Platform Bot" "$BOT_USER"
  usermod -aG docker "$BOT_USER"
  echo "  Created user: $BOT_USER"
else
  echo "  User $BOT_USER already exists"
fi

# Check if Claude Code is authenticated for the bot user
if ! su - "$BOT_USER" -c "claude auth status" &>/dev/null 2>&1; then
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  Claude Code needs authentication.       ║"
  echo "║                                          ║"
  echo "║  A browser link will appear — open it,   ║"
  echo "║  log in, and return here.                ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  su - "$BOT_USER" -c "claude auth login"
  echo ""
  echo "  Claude Code authenticated!"
else
  echo "  Claude Code already authenticated"
fi
echo "[2/7] Done"

# ── 3. Clone repo ──
echo "[3/7] Cloning repository..."
if [ ! -d "$INSTALL_DIR" ]; then
  git clone https://github.com/waimaozi/agent-platform-public.git "$INSTALL_DIR"
else
  echo "  Already cloned, updating..."
  cd "$INSTALL_DIR" && git pull 2>/dev/null || true
fi
chown -R "$BOT_USER":"$BOT_USER" "$INSTALL_DIR"
cd "$INSTALL_DIR"
su - "$BOT_USER" -c "cd $INSTALL_DIR && pnpm install 2>/dev/null"
echo "[3/7] Done"

# ── 4. Database ──
echo "[4/7] Starting database..."
if docker ps | grep -q postgres; then
  echo "  Postgres already running"
else
  cd "$INSTALL_DIR" && docker-compose up -d 2>/dev/null || docker compose up -d
  sleep 5
fi
echo "[4/7] Done"

# ── 5. SSL + nginx ──
echo "[5/7] Configuring SSL + nginx..."
SERVER_IP=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
if [ ! -f /etc/nginx/ssl/agent-platform.crt ]; then
  mkdir -p /etc/nginx/ssl
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/agent-platform.key \
    -out /etc/nginx/ssl/agent-platform.crt \
    -subj "/CN=${SERVER_IP}" 2>/dev/null
fi
if [ ! -f /etc/nginx/sites-enabled/agent-platform ]; then
  cat > /etc/nginx/sites-enabled/agent-platform << NGINX
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
NGINX
  nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || systemctl restart nginx 2>/dev/null
fi
echo "[5/7] Done"

# ── 6. Systemd service ──
echo "[6/7] Creating service..."
cat > /etc/systemd/system/agent-platform.service << SVC
[Unit]
Description=Agent Platform Bot
After=network.target docker.service
[Service]
Type=simple
User=${BOT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/bin/bash -c 'set -a; source ${INSTALL_DIR}/.env; set +a; exec npx tsx simple-bot.ts'
Restart=always
RestartSec=5
TimeoutStopSec=75
KillSignal=SIGTERM
[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload
systemctl enable agent-platform
echo "[6/7] Done"

# ── 7. Setup wizard ──
echo "[7/7] Starting setup wizard..."
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Open in your browser:                   ║"
echo "║                                          ║"
echo "║  http://${SERVER_IP}:8888                ║"
echo "║                                          ║"
echo "║  Complete the setup, then the bot starts ║"
echo "║  automatically as a systemd service.     ║"
echo "║                                          ║"
echo "║  After setup:                            ║"
echo "║    Logs:    journalctl -u agent-platform -f"
echo "║    Restart: systemctl restart agent-platform"
echo "║    Health:  curl -k https://${SERVER_IP}:8443/health"
echo "╚══════════════════════════════════════════╝"
echo ""

# Run wizard as bot user
cd "$INSTALL_DIR"
su - "$BOT_USER" -c "cd $INSTALL_DIR && INSTALL_DIR=$INSTALL_DIR npx tsx setup-wizard.ts"
