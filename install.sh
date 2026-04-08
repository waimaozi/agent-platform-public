#!/bin/bash
set -e
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    Agent Platform — Installer            ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Install system deps
echo "Installing dependencies..."
apt-get update -qq
curl -fsSL https://deb.nodesource.com/setup_22.x 2>/dev/null | bash - 2>/dev/null
apt-get install -y -qq nodejs docker.io docker-compose nginx pandoc git 2>/dev/null
npm install -g pnpm @anthropic-ai/claude-code 2>/dev/null

# Clone
INSTALL_DIR=/opt/agent-platform
if [ ! -d "$INSTALL_DIR" ]; then
  git clone https://github.com/waimaozi/agent-platform-public.git "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
pnpm install 2>/dev/null

# Start Postgres
docker-compose up -d 2>/dev/null
sleep 5

# Setup nginx SSL
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/agent-platform.key \
  -out /etc/nginx/ssl/agent-platform.crt \
  -subj "/CN=${SERVER_IP}" 2>/dev/null

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
nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || nginx 2>/dev/null

# Create systemd service for the bot
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

# Start setup wizard
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Open this URL in your browser:          ║"
echo "║                                          ║"
echo "║  http://${SERVER_IP}:8080                ║"
echo "║                                          ║"
echo "║  Follow the setup wizard to configure    ║"
echo "║  your bot step by step.                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

INSTALL_DIR=$INSTALL_DIR npx tsx setup-wizard.ts
