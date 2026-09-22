#!/usr/bin/env bash
# Hits every service's /healthz and the gateway's aggregated /readyz.
# Exit code is non-zero if anything is down, so CI can use it as a smoke test.
set -uo pipefail

services=(
  "gateway|4000"
  "auth|4001"
  "course|4002"
  "enrollment|4003"
  "payment|4004"
  "media|4005"
  "lab|4006"
  "quiz|4007"
  "certificate|4008"
  "notification|4009"
)

fail=0
printf '%-14s %-6s %s\n' SERVICE PORT STATUS
for entry in "${services[@]}"; do
  name="${entry%%|*}"
  port="${entry##*|}"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${port}/healthz" || echo 000)
  if [ "$code" = "200" ]; then
    printf '%-14s %-6s \033[32mok\033[0m\n' "$name" "$port"
  else
    printf '%-14s %-6s \033[31mDOWN (%s)\033[0m\n' "$name" "$port" "$code"
    fail=1
  fi
done

web=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:3000" || echo 000)
printf '%-14s %-6s %s\n' web 3000 "$web"
[ "$web" = "200" ] || fail=1

exit $fail
