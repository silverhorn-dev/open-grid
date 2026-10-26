#!/bin/sh
# Startet den Server (Node 22) und die Playwright-E2E-Tests in Docker; lokal ist kein Node noetig.
# Der Browser laeuft im Netz des Server-Containers, damit die App auf 127.0.0.1 (sicherer Kontext) laeuft.
# Dateien kommen per `docker cp` statt Bind-Mount in die Container: so laeuft das Skript auch gegen einen
# entfernten Docker-Daemon (DOCKER_HOST, z. B. aus dem Jenkins-Container).
set -eu
cd "$(dirname "$0")/.."
NAME="opengrid-e2e-$$"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.48.2-jammy"
trap 'docker rm -f "$NAME" "$NAME-browser" >/dev/null 2>&1 || true' EXIT

docker create --name "$NAME" node:22-alpine sh -c \
    'cd /work && rm -rf node_modules && npm install --silent && npm run build:css && DATABASE_PATH=/tmp/e2e.sqlite RATE_LIMIT_SCALE=20 node server/index.js' >/dev/null
docker cp -q . "$NAME:/work"
docker start "$NAME" >/dev/null

i=0
until docker exec "$NAME" wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 90 ] && { echo "Server did not start"; docker logs "$NAME"; exit 1; }
    sleep 2
done

for variant in DESKTOP MOBILE OFFLINE; do
    docker create --name "$NAME-browser" --network "container:$NAME" -e "$variant=1" -e "E2E_DEBUG=${E2E_DEBUG:-}" "$PLAYWRIGHT_IMAGE" sh -c \
        'mkdir -p /run-e2e && cd /run-e2e && npm init -y >/dev/null && npm i playwright@1.48.2 --silent >/dev/null && cp /e2e/*.cjs . && for f in *.e2e.cjs; do node "$f" || exit 1; done' >/dev/null
    docker cp -q e2e "$NAME-browser:/e2e"
    docker start -a "$NAME-browser"
    docker rm "$NAME-browser" >/dev/null
done
