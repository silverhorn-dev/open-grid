FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Tailwind vorab kompilieren (kein CDN zur Laufzeit), danach Dev-Abhaengigkeiten entfernen.
COPY index.html admin.html ./
COPY client ./client
COPY scripts/slim-modules.sh ./scripts/
# Danach nur behalten, was der Router wirklich ausliefert (scripts/slim-modules.sh).
RUN npm run build:css && npm prune --omit=dev && sh scripts/slim-modules.sh node_modules

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

# Profilbild-Verifizierung (server/verify.js, documentation/VERIFIZIERUNG.md): YuNet (MIT) und SFace (Apache-2.0)
# aus dem OpenCV Zoo, feste Pruefsummen. Benutzt nur mit VERIFY=on.
FROM alpine:3.20 AS verify-models
RUN mkdir -p /out/verify && cd /out/verify \
    && wget -q -O face_detection_yunet_2023mar.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
    && wget -q -O face_recognition_sface_2021dec.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx \
    && printf '%s  %s\n%s  %s\n' \
        8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4 face_detection_yunet_2023mar.onnx \
        0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79 face_recognition_sface_2021dec.onnx | sha256sum -c -

# Sprachnachrichten verschriftlichen (server/stt-model.js): transformers.js (Apache-2.0), die dazu passende
# onnxruntime-web-Laufzeit (MIT) und onnx-community/whisper-base quantisiert (Apache-2.0), feste Pruefsummen.
# Rechnet nur im Browser; der Router liefert die Dateien aus.
FROM alpine:3.20 AS whisper
RUN mkdir -p /out/whisper/whisper-base/onnx /tmp/w && cd /tmp/w \
    && wget -q -O t.tgz https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.3.2.tgz \
    && wget -q -O o.tgz https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.31.0-dev.20260914-8d85527a0.tgz \
    && tar -xzf t.tgz package/dist/transformers.min.js package/LICENSE \
    && cp package/dist/transformers.min.js /out/whisper/ && cp package/LICENSE /out/whisper/LICENSE-transformers \
    && rm -rf package && tar -xzf o.tgz package/dist/ort-wasm-simd-threaded.asyncify.mjs package/dist/ort-wasm-simd-threaded.asyncify.wasm \
    && cp package/dist/ort-wasm-simd-threaded.asyncify.mjs package/dist/ort-wasm-simd-threaded.asyncify.wasm /out/whisper/ \
    && cd /out/whisper/whisper-base \
    && for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do \
        wget -q -O "$f" "https://huggingface.co/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c/$f"; done \
    && cd /out/whisper && printf '%s\n' \
        '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb  transformers.min.js' \
        '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611  ort-wasm-simd-threaded.asyncify.mjs' \
        '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082  ort-wasm-simd-threaded.asyncify.wasm' \
        'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b  whisper-base/config.json' \
        '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0  whisper-base/generation_config.json' \
        'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d  whisper-base/preprocessor_config.json' \
        '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566  whisper-base/tokenizer.json' \
        '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573  whisper-base/tokenizer_config.json' \
        '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46  whisper-base/onnx/encoder_model_quantized.onnx' \
        'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b  whisper-base/onnx/decoder_model_merged_quantized.onnx' \
        | sha256sum -c - \
    && printf '{"transformers":"4.3.2","ort":"1.31.0-dev.20260914-8d85527a0","model":"onnx-community/whisper-base","commit":"27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c"}\n' > VERSION.json \
    && rm -rf /tmp/w

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
COPY --from=verify-models --chown=opengrid:opengrid /out/verify ./models/verify
COPY --from=whisper --chown=opengrid:opengrid /out/whisper ./models/whisper
# TURN-Pruefung im laufenden Container: `docker compose exec open-grid node scripts/turn-check.mjs`
COPY --chown=opengrid:opengrid scripts/turn-check.mjs scripts/safety-admin.mjs ./scripts/
USER opengrid
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
