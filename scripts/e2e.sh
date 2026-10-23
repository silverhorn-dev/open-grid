#!/bin/sh
# Startet den Server (Node 22) und die Playwright-E2E-Tests in Docker; lokal ist kein Node noetig.
# Der Browser laeuft im Netz des Server-Containers, damit die App auf 127.0.0.1 (sicherer Kontext) laeuft.
set -eu
cd "$(dirname "$0")/.."
NAME="opengrid-e2e-$$"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.48.2-jammy"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" -v "$PWD":/app:ro node:22-alpine sh -c \
    'cp -r /app/. /work && cd /work && rm -rf node_modules && npm install --silent && npm run build:css && DATABASE_PATH=/tmp/e2e.sqlite node server/index.js' >/dev/null

i=0
until docker exec "$NAME" wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 90 ] && { echo "Server did not start"; docker logs "$NAME"; exit 1; }
    sleep 2
done

for variant in DESKTOP MOBILE OFFLINE; do
    docker run --rm --network "container:$NAME" -e "$variant=1" -v "$PWD/e2e":/e2e:ro "$PLAYWRIGHT_IMAGE" sh -c \
        'mkdir -p /run-e2e && cd /run-e2e && npm init -y >/dev/null && npm i playwright@1.48.2 --silent >/dev/null && cp /e2e/*.cjs . && for f in *.e2e.cjs; do node "$f"; done'
done
