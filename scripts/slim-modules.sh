#!/bin/sh
# Verkleinert node_modules fuers Docker-Image (laeuft im Build nach `npm prune --omit=dev`).
# TF.js, onnxruntime-web und NSFWJS fuehrt der Router nie selbst aus: er liefert nur einzelne Dateien an
# den Browser (server/nudity-model.js). Behalten werden genau diese plus package.json und die
# Einstiegsdatei (fuer require.resolve); dazu von Font Awesome nur CSS und Schriften.
# Pruefung: test/dockerfile.test.js (Dateiliste) und ein Image-Build mit Healthcheck.
set -eu
cd "${1:-node_modules}"

keep() {
    dir=$1
    shift
    tmp=$(mktemp -d)
    for file in "$@"; do
        mkdir -p "$tmp/$(dirname "$file")"
        cp -pR "$dir/$file" "$tmp/$file"
    done
    rm -rf "$dir"
    mv "$tmp" "$dir"
}

keep @tensorflow/tfjs package.json dist/tf.es2017.min.js dist/tf.node.js
rm -rf @tensorflow/tfjs-backend-cpu @tensorflow/tfjs-backend-webgl @tensorflow/tfjs-converter @tensorflow/tfjs-core @tensorflow/tfjs-data @tensorflow/tfjs-layers core-js seedrandom

keep onnxruntime-web package.json dist/ort.node.min.js dist/ort.wasm.min.js dist/ort-wasm-simd-threaded.mjs dist/ort-wasm-simd-threaded.wasm
rm -rf onnxruntime-common protobufjs long

rm -rf nsfwjs/dist/esm
keep @fortawesome/fontawesome-free package.json LICENSE.txt css/all.min.css webfonts

find . -name '*.map' -type f -delete
