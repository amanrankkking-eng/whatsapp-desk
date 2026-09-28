#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu/Debian server. Run from the repository folder:
#   sudo ./scripts/setup.sh
# Installs Docker if needed, writes .env with fresh secrets, builds and starts everything.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin is missing"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  read -rp "Domain for the dashboard (its A record must point at this server): " domain
  read -rp "Dashboard username [admin]: " user
  read -rsp "Dashboard password (at least 12 characters): " pass; echo
  [ ${#pass} -ge 12 ] || { echo "The password is too short."; rm .env; exit 1; }
  sed -i "s|^DESK_DOMAIN=.*|DESK_DOMAIN=${domain}|" .env
  sed -i "s|^DESK_USER=.*|DESK_USER=${user:-admin}|" .env
  sed -i "s|^DESK_PASSWORD=.*|DESK_PASSWORD=${pass}|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^EVO_API_KEY=.*|EVO_API_KEY=$(openssl rand -hex 24)|" .env
  chmod 600 .env
  echo ".env written."
fi

docker compose up -d --build
echo
echo "Starting. In a minute open: https://$(grep '^DESK_DOMAIN=' .env | cut -d= -f2)"
echo "Then: Numbers -> Add WhatsApp, and scan the QR with each phone."
