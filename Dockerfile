FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Tailwind vorab kompilieren (kein CDN zur Laufzeit), danach Dev-Abhaengigkeiten entfernen.
COPY tailwind.config.cjs index.html ./
COPY client ./client
RUN npm run build:css && npm prune --omit=dev

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
COPY --chown=opengrid:opengrid package.json index.html ./
COPY --chown=opengrid:opengrid client ./client
COPY --from=dependencies --chown=opengrid:opengrid /app/client/tailwind.css ./client/tailwind.css
COPY --chown=opengrid:opengrid server ./server
USER opengrid
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
