#!/bin/bash
set -e
n# Keep SSH alive during install
(while true; do echo -n "."; sleep 30; done) &
KEEPALIVE_PID=$!
trap "kill $KEEPALIVE_PID 2>/dev/null" EXIT

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    Agent Platform — Installer            ║"
echo "║                                          ║"
echo "║  TIP: Run inside screen or tmux:         ║"
echo "║  screen -S install                       ║"
echo "║  Then paste this command                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""

INSTALL_DIR=/opt/agent-platform

# ── Dependencies (skip if already installed) ──
echo "[1/6] Dependencies..."
command -v node &>/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; }
command -v pnpm &>/dev/null || npm install -g pnpm
command -v docker &>/dev/null || { apt-get update -qq; apt-get install -y docker.io docker-compose; }
command -v nginx &>/dev/null || apt-get install -y nginx
command -v pandoc &>/dev/null || apt-get install -y pandoc
command -v claude &>/dev/null || npm install -g @anthropic-ai/claude-code
echo "[1/6] Done"

# ── Clone (skip if exists) ──
echo "[2/6] Repository..."
if [ ! -d "$INSTALL_DIR" ]; then
  git clone https://github.com/waimaozi/agent-platform-public.git "$INSTALL_DIR"
else
  echo "  Already cloned, updating..."
  cd "$INSTALL_DIR" && git pull 2>/dev/null || true
fi
cd "$INSTALL_DIR"
pnpm install 2>/dev/null
echo "[2/6] Done"

# ── Database (skip if running) ──
echo "[3/6] Database..."
if docker ps | grep -q postgres; then
  echo "  Postgres already running"
else
  docker-compose up -d 2>/dev/null || docker compose up -d
  sleep 5
fi
echo "[3/6] Done"

# ── SSL + nginx (skip if configured) ──
echo "[4/6] SSL + nginx..."
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
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
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_read_timeout 600s;
    }
}
NGINX
  nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || nginx 2>/dev/null
fi
echo "[4/6] Done"

# ── Systemd service (skip if exists) ──
echo "[5/6] Service..."
if [ ! -f /etc/systemd/system/agent-platform.service ]; then
  cat > /etc/systemd/system/agent-platform.service << SVC
[Unit]
Description=Agent Platform Bot
After=network.target docker.service
[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/bin/bash -c 'set -a; source ${INSTALL_DIR}/.env; set +a; exec npx tsx simple-bot.ts'
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
SVC
  systemctl daemon-reload
  systemctl enable agent-platform
fi
echo "[5/6] Done"

# ── Setup wizard ──
echo "[6/6] Starting setup wizard..."
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Open in your browser:                   ║"
echo "║                                          ║"
echo "║  http://${SERVER_IP}:8888                ║"
echo "║                                          ║"
echo "║  Follow the steps to configure your bot  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C to stop the wizard when done."
echo ""

INSTALL_DIR=$INSTALL_DIR exec npx tsx setup-wizard.ts
