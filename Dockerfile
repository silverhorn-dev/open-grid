FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Tailwind vorab kompilieren (kein CDN zur Laufzeit), danach Dev-Abhaengigkeiten entfernen.
COPY index.html admin.html ./
COPY client ./client
RUN npm run build:css && npm prune --omit=dev

# NudeNet 320n (AGPL-3.0) fuer den Nacktbild-Filter, aus dem PyPI-Paket mit fester Pruefsumme (Board T3).
# Eigene Stufe: bleibt im Cache, solange sich hier nichts aendert.
FROM alpine:3.20 AS nudenet
RUN apk add --no-cache unzip \
    && mkdir -p /out/nudenet /tmp/n && cd /tmp/n \
    && wget -q -O n.whl https://files.pythonhosted.org/packages/1c/ee/1aa02d44ba958cc77e16ff1e41a0aac5e721037db7bf62b9c9d124917f87/nudenet-3.4.2-py3-none-any.whl \
    && unzip -q n.whl nudenet/320n.onnx nudenet-3.4.2.dist-info/LICENSE \
    && echo 'c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f  nudenet/320n.onnx' | sha256sum -c - \
    && cp nudenet/320n.onnx nudenet-3.4.2.dist-info/LICENSE /out/nudenet/ \
    && rm -rf /tmp/n

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/open-grid.sqlite
WORKDIR /app
RUN groupadd --system --gid 10001 opengrid \
    && useradd --system --uid 10001 --gid opengrid --home-dir /app opengrid \
    && mkdir -p /app/data \
    && chown -R opengrid:opengrid /app
COPY --from=dependencies --chown=opengrid:opengrid /app/node_modules ./node_modules
COPY --chown=opengrid:opengrid package.json index.html admin.html CHANGELOG.md ./
COPY --chown=opengrid:opengrid client ./client
COPY --from=dependencies --chown=opengrid:opengrid /app/client/tailwind.css ./client/tailwind.css
COPY --chown=opengrid:opengrid server ./server
COPY --chown=opengrid:opengrid i18n ./i18n
COPY --chown=opengrid:opengrid info-site ./info-site
# Optionale Erkennungsmodelle (models/README.md): Bumble aus dem Repository, NudeNet aus der Stufe oben.
COPY --chown=opengrid:opengrid models ./models
COPY --from=nudenet --chown=opengrid:opengrid /out/nudenet ./models/nudenet
# TURN-Pruefung im laufenden Container: `docker compose exec open-grid node scripts/turn-check.mjs`
COPY --chown=opengrid:opengrid scripts/turn-check.mjs scripts/safety-admin.mjs ./scripts/
USER opengrid
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
