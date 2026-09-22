#!/usr/bin/env bash
set -euo pipefail
echo "==> enabling corepack / pnpm"
corepack enable
corepack prepare pnpm@9.15.4 --activate

echo "==> creating .env from .env.example (if missing)"
[ -f .env ] || cp .env.example .env

echo "==> installing dependencies"
pnpm install

echo "==> building shared package"
pnpm build:shared

echo ""
echo "Codespace ready. Next:"
echo "  docker compose up -d"
echo "  pnpm db:migrate && pnpm db:seed"
echo "  pnpm dev"
