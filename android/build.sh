#!/bin/sh
# Baut das APK der Android-App in Docker (kein lokales Android-SDK noetig) und legt es mit Versionsdatei
# nach android/dist/ (opengrid.apk + opengrid.apk.json). Der Router liefert es aus, wenn es unter
# ANDROID_APK_PATH liegt (Standard: data/opengrid.apk).
#
#   sh android/build.sh            # Debug-Build (Debug-Schluessel, zum Testen)
#   sh android/build.sh release    # Release, signiert mit OPENGRID_KEYSTORE (+ _PASSWORD, KEY_ALIAS, KEY_PASSWORD)
set -eu
cd "$(dirname "$0")"
variant="${1:-debug}"
image=opengrid-android-build
docker build -q -t "$image" . >/dev/null
keystore_args=""
if [ "$variant" = "release" ]; then
    : "${OPENGRID_KEYSTORE:?OPENGRID_KEYSTORE fehlt}"
    keystore_args="-v $(realpath "$OPENGRID_KEYSTORE"):/keystore:ro -e OPENGRID_KEYSTORE=/keystore -e OPENGRID_KEYSTORE_PASSWORD -e OPENGRID_KEY_ALIAS -e OPENGRID_KEY_PASSWORD"
fi
task="assemble$(echo "$variant" | cut -c1 | tr a-z A-Z)$(echo "$variant" | cut -c2-)"
# Gradle-Cache im Volume, damit Folge-Builds schnell sind.
# shellcheck disable=SC2086
docker run --rm -v "$PWD":/src -v opengrid-android-gradle:/cache/gradle $keystore_args "$image" gradle --no-daemon -q "$task"
mkdir -p dist
cp "app/build/outputs/apk/$variant/app-$variant.apk" dist/opengrid.apk
version_code=$(sed -n 's/^ *versionCode = \([0-9]*\).*/\1/p' app/build.gradle.kts)
version_name=$(sed -n 's/^ *versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)
printf '{"versionCode":%s,"versionName":"%s"}\n' "$version_code" "$version_name" > dist/opengrid.apk.json
echo "android/dist/opengrid.apk ($version_name, $version_code)"
