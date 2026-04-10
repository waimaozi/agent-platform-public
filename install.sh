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

# ── Ensure we're in a valid directory ──
cd /root 2>/dev/null || cd /

# ── 1. Dependencies ──
echo "[1/8] Installing dependencies..."
apt-get update -qq
command -v node &>/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; }
command -v pnpm &>/dev/null || npm install -g pnpm
command -v docker &>/dev/null || apt-get install -y docker.io docker-compose
command -v nginx &>/dev/null || apt-get install -y nginx
command -v pandoc &>/dev/null || apt-get install -y pandoc
command -v git &>/dev/null || apt-get install -y git
npm install -g @anthropic-ai/claude-code 2>/dev/null || true
echo "[1/8] Done"

# ── 2. Create non-root user (Claude Code refuses root) ──
echo "[2/8] Setting up bot user..."
if ! id "$BOT_USER" &>/dev/null; then
  adduser --disabled-password --gecos "Agent Platform Bot" "$BOT_USER"
  echo "  Created user: $BOT_USER"
else
  echo "  User $BOT_USER already exists"
fi
usermod -aG docker "$BOT_USER" 2>/dev/null || true
echo "[2/8] Done"

# ── 3. Authenticate Claude Code ──
echo "[3/8] Authenticating Claude Code..."
if su - "$BOT_USER" -c "claude auth status 2>&1" | grep -qi "logged in\|authenticated\|active"; then
  echo "  Claude Code already authenticated"
else
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║  Claude Code needs authentication.       ║"
  echo "║                                          ║"
  echo "║  1. A URL will appear below              ║"
  echo "║  2. Open it in YOUR browser (not VPS)    ║"
  echo "║  3. Log in with your Anthropic account   ║"
  echo "║  4. It will complete automatically        ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  su - "$BOT_USER" -c "claude auth login" || {
    echo ""
    echo "  Auth failed. You can retry later:"
    echo "    su - $BOT_USER -c 'claude auth login'"
    echo ""
    echo "  Continuing install without auth..."
  }
fi
echo "[3/8] Done"

# ── 4. Clone repo ──
echo "[4/8] Cloning repository..."
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
if [ ! -d "$INSTALL_DIR/.git" ]; then
  rm -rf "$INSTALL_DIR" 2>/dev/null || true
  git clone https://github.com/waimaozi/agent-platform-public.git "$INSTALL_DIR"
else
  echo "  Already cloned, updating..."
  cd "$INSTALL_DIR" && git pull 2>/dev/null || true
fi
chown -R "$BOT_USER":"$BOT_USER" "$INSTALL_DIR"
su - "$BOT_USER" -c "cd $INSTALL_DIR && pnpm install 2>/dev/null"
echo "[4/8] Done"

# ── 5. Database ──
echo "[5/8] Starting database..."
if docker ps 2>/dev/null | grep -q postgres; then
  echo "  Postgres already running"
else
  cd "$INSTALL_DIR"
  docker-compose up -d 2>/dev/null || docker compose up -d 2>/dev/null || echo "  Warning: docker-compose failed. Postgres not started."
  sleep 5
fi
echo "[5/8] Done"

# ── 6. SSL + nginx ──
echo "[6/8] Configuring SSL + nginx..."
SERVER_IP=$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || curl -4 -s --max-time 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
echo "  Server IP: $SERVER_IP"

if [ ! -f /etc/nginx/ssl/agent-platform.crt ]; then
  mkdir -p /etc/nginx/ssl
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/agent-platform.key \
    -out /etc/nginx/ssl/agent-platform.crt \
    -subj "/CN=${SERVER_IP}" 2>/dev/null
fi

# Always regenerate nginx config (IP may have changed)
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
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null
echo "[6/8] Done"

# ── 7. Systemd service ──
echo "[7/8] Creating service..."
# Kill anything on port 3000 before starting
fuser -k 3000/tcp 2>/dev/null || true

cat > /etc/systemd/system/agent-platform.service << SVC
[Unit]
Description=Agent Platform Bot
After=network.target docker.service
[Service]
Type=simple
User=${BOT_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStartPre=/bin/bash -c 'fuser -k 3000/tcp 2>/dev/null || true'
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

# Save server IP for wizard and webhook
echo "SERVER_IP=${SERVER_IP}" > "${INSTALL_DIR}/.server-ip"
chown "$BOT_USER":"$BOT_USER" "${INSTALL_DIR}/.server-ip"
echo "[7/8] Done"

# ── 8. Setup wizard ──
echo "[8/8] Starting setup wizard..."
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║                                              ║"
echo "║  Open in your browser:                       ║"
echo "║  http://${SERVER_IP}:8888                    ║"
echo "║                                              ║"
echo "║  You'll need:                                ║"
echo "║  - Telegram bot token (from @BotFather)      ║"
echo "║  - Everything else is optional               ║"
echo "║                                              ║"
echo "║  After the wizard, your bot starts           ║"
echo "║  automatically and the webhook is set.       ║"
echo "║                                              ║"
echo "║  Useful commands:                            ║"
echo "║    journalctl -u agent-platform -f           ║"
echo "║    systemctl restart agent-platform          ║"
echo "║    curl -k https://${SERVER_IP}:8443/health  ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Open firewall for wizard
ufw allow 8888/tcp 2>/dev/null || iptables -I INPUT -p tcp --dport 8888 -j ACCEPT 2>/dev/null || true

# Kill any existing wizard
fuser -k 8888/tcp 2>/dev/null || true
sleep 1

# Run wizard as bot user
cd "$INSTALL_DIR"
su - "$BOT_USER" -c "cd $INSTALL_DIR && SERVER_IP=$SERVER_IP INSTALL_DIR=$INSTALL_DIR npx tsx setup-wizard.ts"
