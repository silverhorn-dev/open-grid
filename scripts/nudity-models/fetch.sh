#!/bin/sh
# Optionale Nacktbild-Modelle herunterladen bzw. umwandeln (Board T3). Laeuft nur mit Docker.
#
#   sh scripts/nudity-models/fetch.sh [--volume <docker-volume> | --dir <ordner>] nudenet bumble
#
# Ziel: Ordner `nudity-models` im Datenordner des Routers (NUDITY_MODEL_DIR, Standard
# /app/data/nudity-models). Mit --volume wird direkt in das Docker-Volume geschrieben, z. B.
# `--volume open-grid_open-grid-data` (Name: `docker volume ls`). Danach den Router neu starten und
# NUDITY_MODEL=nudenet bzw. bumble setzen (oder auf der Testseite im Debug-Modus vergleichen).
#
#   nudenet  NudeNet 320n (AGPL-3.0) aus dem PyPI-Paket nudenet 3.4.2, ~12 MB, Pruefsumme fest
#   bumble   Bumble Private Detector (Apache-2.0), ~600 MB Download, Umwandlung nach TF.js (uint8,
#            ~51 MB) in einem Python-Container; braucht ~3 GB freien Platz und einige Minuten
set -eu

TARGET_VOLUME=""
TARGET_DIR=""
MODELS=""
while [ $# -gt 0 ]; do
    case "$1" in
        --volume) TARGET_VOLUME="$2"; shift 2 ;;
        --dir) TARGET_DIR="$2"; shift 2 ;;
        nudenet|bumble) MODELS="$MODELS $1"; shift ;;
        *) echo "Unbekannt: $1" >&2; exit 1 ;;
    esac
done
[ -n "$MODELS" ] || { echo "Modelle angeben: nudenet und/oder bumble" >&2; exit 1; }
if [ -n "$TARGET_VOLUME" ]; then
    MOUNT="$TARGET_VOLUME:/data"
    OUT=/data/nudity-models
elif [ -n "$TARGET_DIR" ]; then
    mkdir -p "$TARGET_DIR"
    MOUNT="$(cd "$TARGET_DIR" && pwd):/data"
    OUT=/data
else
    echo "Ziel angeben: --volume <docker-volume> oder --dir <ordner>" >&2; exit 1
fi
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

NUDENET_WHEEL=https://files.pythonhosted.org/packages/1c/ee/1aa02d44ba958cc77e16ff1e41a0aac5e721037db7bf62b9c9d124917f87/nudenet-3.4.2-py3-none-any.whl
NUDENET_SHA256=c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f
BUMBLE_ZIP=https://storage.googleapis.com/private_detector/private_detector_with_frozen.zip

for model in $MODELS; do
    case "$model" in
        nudenet)
            echo "NudeNet: Download aus PyPI ..."
            docker run --rm -v "$MOUNT" alpine:3.20 sh -euc "
                apk add --no-cache unzip >/dev/null
                mkdir -p $OUT/nudenet /tmp/n && cd /tmp/n
                wget -q -O n.whl $NUDENET_WHEEL
                unzip -q -o n.whl nudenet/320n.onnx 'nudenet-3.4.2.dist-info/LICENSE'
                echo '$NUDENET_SHA256  nudenet/320n.onnx' | sha256sum -c -
                cp nudenet/320n.onnx $OUT/nudenet/320n.onnx
                cp nudenet-3.4.2.dist-info/LICENSE $OUT/nudenet/LICENSE
            "
            ;;
        bumble)
            echo "Bumble: Download (~600 MB) und Umwandlung nach TF.js ..."
            docker run --rm -v "$MOUNT" -v "$SCRIPTS:/s:ro" -e TF_CPP_MIN_LOG_LEVEL=3 python:3.11-slim sh -euc "
                apt-get update -qq >/dev/null && apt-get install -y -qq wget unzip >/dev/null
                # Der Konverter importiert JAX und Decision Forests, braucht sie fuer Graph-Modelle aber nicht.
                mkdir -p /stubs/tensorflow_decision_forests /stubs/jax/experimental
                touch /stubs/tensorflow_decision_forests/__init__.py /stubs/jax/__init__.py /stubs/jax/experimental/__init__.py /stubs/jax/experimental/jax2tf.py
                pip install -q --no-cache-dir tensorflow-cpu==2.15.1 tf-keras==2.15.1 tensorflow-hub==0.16.1 packaging
                pip install -q --no-cache-dir --no-deps tensorflowjs==4.17.0
                mkdir -p /tmp/b && cd /tmp/b
                wget -q -O b.zip $BUMBLE_ZIP
                unzip -q b.zip '*/saved_model/*' '*/LICENSE' -x '__MACOSX/*'
                rm b.zip
                SAVED=\$(dirname \$(find /tmp/b -name saved_model.pb | head -1))
                rm -rf /tmp/bumble-out
                PYTHONPATH=/stubs python /s/convert-bumble.py \"\$SAVED\" /tmp/bumble-out uint8
                rm -rf $OUT/bumble && mkdir -p $OUT && cp -r /tmp/bumble-out $OUT/bumble
                cp \$(find /tmp/b -name LICENSE | head -1) $OUT/bumble/LICENSE
            "
            ;;
    esac
done
echo "Fertig. Router neu starten; Modelle unter Einstellungen > Medien > Schutz > Erkennung testen (Debug-Modus)."
