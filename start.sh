#!/usr/bin/env bash
set -uo pipefail

LOG_DIR="$HOME/lp-logs"
mkdir -p "$LOG_DIR"
MAIN_LOG="$LOG_DIR/startup.log"
exec > >(tee -a "$MAIN_LOG") 2>&1

step() { echo; echo "=================================================="; echo "== $1"; echo "=================================================="; }
retry() {
  local n=1 max=5 delay=8
  until "$@"; do
    if [ $n -ge $max ]; then
      echo "!! Command failed after $max attempts: $*"
      return 1
    fi
    echo "-- attempt $n failed, retrying in ${delay}s: $*"
    n=$((n+1))
    sleep $delay
  done
}

step "1/9  Installing dependencies (pnpm install)"
retry pnpm install || { echo "FATAL: pnpm install failed"; exit 1; }

step "2/9  Pulling Docker images one at a time (with retries)"
for img in postgres:17-alpine redis:7-alpine mailhog/mailhog:latest minio/minio:latest; do
  echo "-- pulling $img"
  retry docker pull "$img" || { echo "FATAL: could not pull $img"; exit 1; }
done

step "3/9  Starting containers (postgres, redis, mailhog, minio)"
retry docker compose up -d || { echo "FATAL: docker compose up failed"; exit 1; }

step "4/9  Waiting for Postgres to accept connections"
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U lp >/dev/null 2>&1; then
    echo "-- postgres is ready"
    break
  fi
  echo "-- waiting for postgres... ($i/30)"
  sleep 2
  if [ "$i" -eq 30 ]; then echo "FATAL: postgres never became ready"; exit 1; fi
done

step "5/9  Running database migrations"
retry pnpm db:migrate || { echo "FATAL: db:migrate failed"; exit 1; }

step "6/9  Seeding demo data (courses, quizzes, labs, users)"
retry pnpm db:seed || { echo "FATAL: db:seed failed"; exit 1; }

step "7/9  Bootstrapping MinIO storage bucket"
bash scripts/bootstrap-minio.sh || echo "-- non-fatal: minio bootstrap had an issue, continuing"

step "8/9  Starting the application (background, logs at $LOG_DIR/dev.log)"
nohup pnpm dev > "$LOG_DIR/dev.log" 2>&1 &
echo $! > "$LOG_DIR/dev.pid"
echo "-- app starting in background (PID $(cat "$LOG_DIR/dev.pid"))"

step "9/9  Waiting for services to come up and running health checks"
sleep 20
for i in $(seq 1 20); do
  if curl -sf http://localhost:4000/healthz >/dev/null 2>&1; then
    echo "-- gateway is responding"
    break
  fi
  echo "-- waiting for gateway... ($i/20)"
  sleep 5
done

echo
echo "-- running full health check across all services:"
pnpm health || echo "-- some services may still be starting; see $LOG_DIR/dev.log for details"

echo
echo "=================================================="
echo " DONE"
echo "=================================================="
echo "App logs:      tail -f $LOG_DIR/dev.log"
echo "Startup log:   $MAIN_LOG"
echo "Stop the app:  kill \$(cat $LOG_DIR/dev.pid)"
echo
echo "Once port 3000 shows as forwarded (check the 'Ports' tab), open it in your browser."
echo "MailHog (test emails) is on port 8025."
